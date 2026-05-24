require('dotenv').config()

const express = require('express')
const cors = require('cors')
const { createServer } = require('http')
const { Server } = require('socket.io')
const { v4: uuidv4 } = require('uuid')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const app = express()
const httpServer = createServer(app)

const PORT = process.env.PORT || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'appradar-dev-secret-change-in-production'
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:4173']

// ─── Database ────────────────────────────────────────────────────────────────

const dataDir = path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir)

const db = new Database(path.join(dataDir, 'appradar.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    uuid TEXT PRIMARY KEY,
    user TEXT UNIQUE NOT NULL,
    passw TEXT NOT NULL,
    nombre TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT '',
    uuid_team TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'runner'
  );

  CREATE TABLE IF NOT EXISTS trails (
    trailUuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    distanceKm REAL DEFAULT 0,
    elevationM REAL DEFAULT 0,
    maxSkip INTEGER DEFAULT 1,
    createdBy TEXT NOT NULL,
    isActive INTEGER DEFAULT 0,
    startDate TEXT,
    teamUuid TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS waypoints (
    waypointUuid TEXT PRIMARY KEY,
    trailUuid TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    name TEXT DEFAULT '',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius REAL DEFAULT 50,
    FOREIGN KEY (trailUuid) REFERENCES trails(trailUuid) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS race_runs (
    runUuid TEXT PRIMARY KEY,
    trailUuid TEXT NOT NULL,
    userUuid TEXT NOT NULL,
    startTime INTEGER,
    endTime INTEGER,
    totalTime INTEGER DEFAULT 0,
    isCompleted INTEGER DEFAULT 0,
    isAbandoned INTEGER DEFAULT 0,
    sessionUuid TEXT DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks (
    trackUuid TEXT PRIMARY KEY,
    runUuid TEXT NOT NULL,
    waypointUuid TEXT NOT NULL,
    trailUuid TEXT NOT NULL,
    userUuid TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gps_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userUuid TEXT NOT NULL,
    trailUuid TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    accuracy REAL,
    timestamp INTEGER NOT NULL
  );
`)

// Migrations
try { db.exec(`ALTER TABLE users ADD COLUMN teamStatus TEXT DEFAULT 'accepted'`) } catch (e) {}
try { db.exec(`ALTER TABLE trails ADD COLUMN teamUuid TEXT DEFAULT NULL`) } catch (e) {}
try { db.exec(`ALTER TABLE race_runs ADD COLUMN isAbandoned INTEGER DEFAULT 0`) } catch (e) {}
try { db.exec(`ALTER TABLE race_runs ADD COLUMN sessionUuid TEXT DEFAULT NULL`) } catch (e) {}
db.exec(`CREATE INDEX IF NOT EXISTS idx_gps_user_trail_ts ON gps_positions(userUuid, trailUuid, timestamp)`)

// Seed admin user if not exists
const adminExists = db.prepare('SELECT 1 FROM users WHERE user = ?').get('admin')
if (!adminExists) {
  const hash = bcrypt.hashSync('1234', 10)
  db.prepare(`
    INSERT INTO users (uuid, user, passw, nombre, team, uuid_team, role, teamStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), 'admin', hash, 'Admin User', 'Team Alpha', uuidv4(), 'superuser', 'accepted')
  console.log('Admin seed: usuario=admin, contraseña=1234, rol=superuser')
} else {
  // Ensure admin is superuser
  db.prepare(`UPDATE users SET role = 'superuser' WHERE user = 'admin'`).run()
}

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: CORS_ORIGINS, credentials: true }))
app.use(express.json())

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' })
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Sin permiso' })
    }
    next()
  }
}

// ─── Teams (Organizers) ────────────────────────────────────────────────────────

app.get('/teams', (req, res) => {
  const teams = db.prepare(`SELECT DISTINCT uuid_team, team FROM users WHERE role = 'organizer'`).all()
  res.json(teams)
})

app.get('/team/requests', authMiddleware, requireRole('organizer'), (req, res) => {
  const requests = db.prepare(`SELECT uuid, user, nombre, team, role, teamStatus FROM users WHERE uuid_team = ? AND teamStatus = 'pending'`).all(req.user.uuid_team)
  res.json(requests)
})

app.post('/team/requests/:userUuid/accept', authMiddleware, requireRole('organizer'), (req, res) => {
  db.prepare(`UPDATE users SET teamStatus = 'accepted' WHERE uuid = ? AND uuid_team = ?`).run(req.params.userUuid, req.user.uuid_team)
  res.json({ ok: true })
})

app.post('/team/requests/:userUuid/reject', authMiddleware, requireRole('organizer'), (req, res) => {
  db.prepare(`UPDATE users SET teamStatus = 'rejected' WHERE uuid = ? AND uuid_team = ?`).run(req.params.userUuid, req.user.uuid_team)
  res.json({ ok: true })
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/auth/register', (req, res) => {
  const { user, passw, nombre, team, role, uuid_team: inputTeamUuid } = req.body
  if (!user || !passw || !nombre) return res.status(400).json({ error: 'Faltan campos requeridos' })
  if (passw.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' })

  const existing = db.prepare('SELECT 1 FROM users WHERE user = ?').get(user)
  if (existing) return res.status(409).json({ error: 'El usuario ya existe' })

  const uuid = uuidv4()
  const hash = bcrypt.hashSync(passw, 10)
  const userRole = ['runner', 'organizer', 'spectator'].includes(role) ? role : 'runner'
  
  let finalTeamUuid = uuidv4()
  let finalTeamName = team || ''
  let teamStatus = 'accepted'

  if (userRole === 'runner') {
    if (!inputTeamUuid) return res.status(400).json({ error: 'Debes seleccionar un equipo' })
    const org = db.prepare(`SELECT team FROM users WHERE uuid_team = ? AND role = 'organizer' LIMIT 1`).get(inputTeamUuid)
    if (!org) return res.status(404).json({ error: 'Equipo no encontrado' })
    finalTeamUuid = inputTeamUuid
    finalTeamName = org.team
    teamStatus = 'pending'
  }

  db.prepare(`
    INSERT INTO users (uuid, user, passw, nombre, team, uuid_team, role, teamStatus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, user, hash, nombre, finalTeamName, finalTeamUuid, userRole, teamStatus)

  const newUser = { uuid, user, nombre, team: finalTeamName, uuid_team: finalTeamUuid, role: userRole, teamStatus }
  const token = jwt.sign({ uuid, user, role: userRole, uuid_team: finalTeamUuid, teamStatus }, JWT_SECRET, { expiresIn: '7d' })
  res.status(201).json({ token, user: newUser })
})

app.post('/auth/login', (req, res) => {
  const { user, passw } = req.body
  const found = db.prepare('SELECT * FROM users WHERE user = ?').get(user)
  if (!found || !bcrypt.compareSync(passw, found.passw)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  }
  const { passw: _p, ...safeUser } = found
  const token = jwt.sign({ uuid: found.uuid, user: found.user, role: found.role, uuid_team: found.uuid_team, teamStatus: found.teamStatus }, JWT_SECRET, {
    expiresIn: '7d',
  })
  res.json({ token, user: safeUser })
})

// ─── Trails ───────────────────────────────────────────────────────────────────

app.get('/trails', (req, res) => {
  const header = req.headers.authorization
  let user = null
  if (header?.startsWith('Bearer ')) {
    try { user = jwt.verify(header.slice(7), JWT_SECRET) } catch {}
  }

  let trails = []
  if (!user) {
    trails = db.prepare('SELECT * FROM trails WHERE teamUuid IS NULL ORDER BY rowid DESC').all()
  } else if (user.role === 'superuser') {
    trails = db.prepare('SELECT * FROM trails ORDER BY rowid DESC').all()
  } else if (user.role === 'organizer' || user.teamStatus === 'accepted') {
    trails = db.prepare('SELECT * FROM trails WHERE teamUuid IS NULL OR teamUuid = ? ORDER BY rowid DESC').all(user.uuid_team)
  } else {
    trails = db.prepare('SELECT * FROM trails WHERE teamUuid IS NULL ORDER BY rowid DESC').all()
  }
  
  res.json(trails.map(t => ({ ...t, isActive: !!t.isActive })))
})

app.get('/trails/:trailId/details', (req, res) => {
  const trail = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(req.params.trailId)
  if (!trail) return res.status(404).json({ error: 'Carrera no encontrada' })
  const waypoints = db
    .prepare('SELECT * FROM waypoints WHERE trailUuid = ? ORDER BY "order"')
    .all(req.params.trailId)
  res.json({ ...trail, isActive: !!trail.isActive, waypoints })
})

app.post('/trails', authMiddleware, requireRole('organizer', 'superuser'), (req, res) => {
  const { name, description, distanceKm, elevationM, maxSkip, waypoints } = req.body
  if (!name) return res.status(400).json({ error: 'El nombre es requerido' })
  if (!waypoints?.length) return res.status(400).json({ error: 'Se requieren waypoints' })

  const trailUuid = uuidv4()
  const teamUuid = req.user.role === 'superuser' ? null : req.user.uuid_team

  db.prepare(`
    INSERT INTO trails (trailUuid, name, description, distanceKm, elevationM, maxSkip, createdBy, teamUuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trailUuid, name, description || '', distanceKm || 0, elevationM || 0, maxSkip ?? 1, req.user.uuid, teamUuid)

  const insertWp = db.prepare(`
    INSERT INTO waypoints (waypointUuid, trailUuid, "order", name, lat, lon, radius)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const wp of waypoints) {
    insertWp.run(uuidv4(), trailUuid, wp.order, wp.name || '', wp.lat, wp.lon, wp.radius || 50)
  }

  const trail = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(trailUuid)
  res.status(201).json({ ...trail, isActive: false })
})

app.put('/trails/:trailId', authMiddleware, requireRole('organizer', 'superuser'), (req, res) => {
  const trail = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(req.params.trailId)
  if (!trail) return res.status(404).json({ error: 'Carrera no encontrada' })
  if (req.user.role !== 'superuser' && trail.createdBy !== req.user.uuid) return res.status(403).json({ error: 'Sin permiso' })

  const { name, description, distanceKm, elevationM, maxSkip } = req.body
  db.prepare(`
    UPDATE trails SET name=?, description=?, distanceKm=?, elevationM=?, maxSkip=?
    WHERE trailUuid=?
  `).run(
    name ?? trail.name,
    description ?? trail.description,
    distanceKm ?? trail.distanceKm,
    elevationM ?? trail.elevationM,
    maxSkip ?? trail.maxSkip,
    req.params.trailId
  )
  const updated = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(req.params.trailId)
  res.json({ ...updated, isActive: !!updated.isActive })
})

app.delete('/trails/:trailId', authMiddleware, requireRole('organizer', 'superuser'), (req, res) => {
  const trail = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(req.params.trailId)
  if (!trail) return res.status(404).json({ error: 'Carrera no encontrada' })
  if (req.user.role !== 'superuser' && trail.createdBy !== req.user.uuid) return res.status(403).json({ error: 'Sin permiso' })
  db.prepare('DELETE FROM trails WHERE trailUuid = ?').run(req.params.trailId)
  res.status(204).end()
})

app.post('/trails/:trailId/activate', authMiddleware, requireRole('organizer', 'superuser'), (req, res) => {
  const trail = db.prepare('SELECT * FROM trails WHERE trailUuid = ?').get(req.params.trailId)
  if (!trail) return res.status(404).json({ error: 'Carrera no encontrada' })
  if (req.user.role !== 'superuser' && trail.createdBy !== req.user.uuid) return res.status(403).json({ error: 'Sin permiso' })
  db.prepare('UPDATE trails SET isActive = 1 WHERE trailUuid = ?').run(req.params.trailId)
  res.json({ ok: true })
})

// ─── Race Runs & Tracks ───────────────────────────────────────────────────────

function findOrCreateSession(trailUuid, startTime) {
  const ts = startTime || Date.now()
  const ONE_HOUR_MS = 60 * 60 * 1000
  const row = db.prepare(`
    SELECT sessionUuid, MIN(startTime) as sessionStart
    FROM race_runs
    WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    GROUP BY sessionUuid
    HAVING sessionStart >= ? AND sessionStart <= ?
    ORDER BY sessionStart DESC
    LIMIT 1
  `).get(trailUuid, ts - ONE_HOUR_MS, ts + ONE_HOUR_MS) // Agregado margen superior
  return row?.sessionUuid ?? uuidv4()
}

app.post('/runs/upload', authMiddleware, (req, res) => {
  const run = req.body
  const existing = db.prepare('SELECT sessionUuid, startTime FROM race_runs WHERE runUuid = ?').get(run.runUuid)

  const sessionUuid = existing?.sessionUuid || findOrCreateSession(run.trailUuid, run.startTime)

  if (!existing) {
    const lastRun = db.prepare(`
      SELECT startTime FROM race_runs
      WHERE trailUuid = ? AND userUuid = ?
      ORDER BY startTime DESC LIMIT 1
    `).get(run.trailUuid, run.userUuid)

    if (lastRun) {
      const diff = (run.startTime || Date.now()) - lastRun.startTime
      const ONE_HOUR = 3600_000
      if (diff < ONE_HOUR) {
        const remaining = Math.ceil((ONE_HOUR - diff) / 60000)
        return res.status(403).json({
          error: `Debes esperar ${remaining} minutos para iniciar una nueva carrera en esta ruta.`,
          remainingMinutes: remaining
        })
      }
    }

    db.prepare(`
      INSERT INTO race_runs (runUuid, trailUuid, userUuid, startTime, endTime, totalTime, isCompleted, isAbandoned, sessionUuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.runUuid, run.trailUuid, run.userUuid, run.startTime, run.endTime, run.totalTime, run.isCompleted ? 1 : 0, run.isAbandoned ? 1 : 0, sessionUuid)
  } else {
    db.prepare('UPDATE race_runs SET sessionUuid = ?, isCompleted = ?, isAbandoned = ?, startTime = ?, endTime = ?, totalTime = ? WHERE runUuid = ?').run(
      sessionUuid,
      run.isCompleted ? 1 : 0,
      run.isAbandoned ? 1 : 0,
      run.startTime || existing.startTime,
      run.endTime,
      run.totalTime,
      run.runUuid
    )
  }
  res.status(200).json({ ok: true, sessionUuid })
})

app.post('/tracks/upload', authMiddleware, (req, res) => {
  const tracks = Array.isArray(req.body) ? req.body : [req.body]
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tracks (trackUuid, runUuid, waypointUuid, trailUuid, userUuid, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((items) => {
    for (const t of items) {
      insert.run(t.trackUuid, t.runUuid, t.waypointUuid, t.trailUuid, t.userUuid || req.user.uuid, t.timestamp)
    }
  })
  insertMany(tracks)
  res.status(200).json({ ok: true })

  const affectedTrails = [...new Set(tracks.map(t => t.trailUuid).filter(Boolean))]
  for (const trailUuid of affectedTrails) {
    const firstTrack = tracks.find(t => t.trailUuid === trailUuid)
    const sessionRow = firstTrack
      ? db.prepare('SELECT sessionUuid FROM race_runs WHERE runUuid = ?').get(firstTrack.runUuid)
      : null
    const rankings = computeRankings(trailUuid, null, sessionRow?.sessionUuid ?? null)
    io.to(`race:${trailUuid}`).emit('race_update', rankings)
  }
})

// ─── Rankings ─────────────────────────────────────────────────────────────────

function latestSession(trailUuid) {
  const row = db.prepare(`
    SELECT sessionUuid FROM race_runs
    WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    GROUP BY sessionUuid ORDER BY MAX(startTime) DESC LIMIT 1
  `).get(trailUuid)
  return row?.sessionUuid ?? null
}

function computeRankings(trailUuid, teamUuid, sessionUuid = null) {
  let query, params
  if (sessionUuid && teamUuid) {
    query = `SELECT rr.* FROM race_runs rr JOIN users u ON rr.userUuid = u.uuid WHERE rr.trailUuid = ? AND rr.sessionUuid = ? AND u.uuid_team = ?`
    params = [trailUuid, sessionUuid, teamUuid]
  } else if (sessionUuid) {
    query = `SELECT * FROM race_runs WHERE trailUuid = ? AND sessionUuid = ?`
    params = [trailUuid, sessionUuid]
  } else if (teamUuid) {
    query = `SELECT rr.* FROM race_runs rr JOIN users u ON rr.userUuid = u.uuid WHERE rr.trailUuid = ? AND u.uuid_team = ?`
    params = [trailUuid, teamUuid]
  } else {
    query = `SELECT * FROM race_runs WHERE trailUuid = ?`
    params = [trailUuid]
  }
  const runs = db.prepare(query).all(...params)

  const totalWaypoints = db
    .prepare('SELECT COUNT(*) as c FROM waypoints WHERE trailUuid = ?')
    .get(trailUuid)?.c ?? 0

  const rankings = runs.map((run) => {
    const user = db.prepare('SELECT nombre, team FROM users WHERE uuid = ?').get(run.userUuid)
    const reached = db
      .prepare('SELECT COUNT(*) as c FROM tracks WHERE runUuid = ? AND trailUuid = ?')
      .get(run.runUuid, trailUuid).c
    const lastTrack = db
      .prepare('SELECT MAX(timestamp) as t FROM tracks WHERE runUuid = ? AND trailUuid = ?')
      .get(run.runUuid, trailUuid)

    return {
      userUuid: run.userUuid,
      userName: user?.nombre ?? 'Desconocido',
      teamName: user?.team ?? '',
      waypointsReached: reached,
      totalWaypoints,
      lastWaypointTime: lastTrack?.t ?? 0,
      totalTime: run.totalTime,
      isCompleted: run.isCompleted === 1,
      isAbandoned: run.isAbandoned === 1,
    }
  })

  rankings.sort((a, b) => {
    if (b.waypointsReached !== a.waypointsReached) return b.waypointsReached - a.waypointsReached
    return a.lastWaypointTime - b.lastWaypointTime
  })

  return rankings
}

app.get('/rankings', (req, res) => {
  const { trailUuid, teamUuid, sessionUuid: reqSession } = req.query
  if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })
  const sessionUuid = reqSession || latestSession(trailUuid)
  res.json(computeRankings(trailUuid, teamUuid || null, sessionUuid))
})

// ─── Race Sessions & Live Positions ──────────────────────────────────────────

app.get('/races/sessions', (req, res) => {
  const { trailUuid } = req.query
  if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })
  const sessions = db.prepare(`
    SELECT sessionUuid, MIN(startTime) as startTime, COUNT(*) as runnerCount
    FROM race_runs
    WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    GROUP BY sessionUuid
    ORDER BY startTime DESC
  `).all(trailUuid)
  res.json(sessions)
})

app.get('/races/live', (req, res) => {
  const { trailUuid, sessionUuid: reqSession } = req.query
  if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })

  const sessionUuid = reqSession || latestSession(trailUuid)
  if (!sessionUuid) return res.json([])

  const runs = db.prepare('SELECT * FROM race_runs WHERE trailUuid = ? AND sessionUuid = ?').all(trailUuid, sessionUuid)
  const ONLINE_MS = 120_000
  const now = Date.now()

  const positions = runs.map((run) => {
    const user = db.prepare('SELECT nombre, team FROM users WHERE uuid = ?').get(run.userUuid)

    const gps = db.prepare(`
      SELECT lat, lon, timestamp FROM gps_positions
      WHERE userUuid = ? AND trailUuid = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(run.userUuid, trailUuid)

    if (gps && (now - gps.timestamp) <= ONLINE_MS) {
      return { userUuid: run.userUuid, userName: user?.nombre ?? 'Desconocido', teamName: user?.team ?? '', lat: gps.lat, lon: gps.lon, timestamp: gps.timestamp, isOnline: true }
    }

    const lastWp = db.prepare(`
      SELECT w.lat, w.lon, t.timestamp
      FROM tracks t JOIN waypoints w ON w.waypointUuid = t.waypointUuid
      WHERE t.runUuid = ? AND t.trailUuid = ?
      ORDER BY t.timestamp DESC LIMIT 1
    `).get(run.runUuid, trailUuid)

    if (!lastWp) return null
    return { userUuid: run.userUuid, userName: user?.nombre ?? 'Desconocido', teamName: user?.team ?? '', lat: lastWp.lat, lon: lastWp.lon, timestamp: lastWp.timestamp, isOnline: false }
  }).filter(Boolean)

  res.json(positions)
})

app.post('/gps/upload', authMiddleware, (req, res) => {
  const { trailUuid, lat, lon, accuracy, timestamp } = req.body
  if (!trailUuid || lat == null || lon == null) return res.status(400).json({ error: 'Faltan datos' })
  const ts = timestamp || Date.now()

  db.prepare(`
    INSERT INTO gps_positions (userUuid, trailUuid, lat, lon, accuracy, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.uuid, trailUuid, lat, lon, accuracy ?? null, ts)

  const user = db.prepare('SELECT nombre, team FROM users WHERE uuid = ?').get(req.user.uuid)
  io.to(`race:${trailUuid}`).emit('position_broadcast', {
    userUuid: req.user.uuid,
    userName: user?.nombre ?? req.user.user,
    teamName: user?.team ?? '',
    lat, lon, accuracy, timestamp: ts,
    isOnline: true,
  })

  res.status(200).json({ ok: true })
})

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGINS, credentials: true },
})

io.use((socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) return next(new Error('Token requerido'))
  try {
    socket.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    next(new Error('Token inválido'))
  }
})

io.on('connection', (socket) => {
  console.log(`WS connect: ${socket.user?.user}`)

  socket.on('join_race', ({ trailUuid }) => {
    socket.join(`race:${trailUuid}`)
  })

  socket.on('leave_race', ({ trailUuid }) => {
    socket.leave(`race:${trailUuid}`)
  })

  socket.on('position_update', ({ trailUuid, lat, lon, accuracy }) => {
    if (!trailUuid || lat == null || lon == null) return

    const user = db.prepare('SELECT nombre, team FROM users WHERE uuid = ?').get(socket.user.uuid)
    const timestamp = Date.now()

    db.prepare(`
      INSERT INTO gps_positions (userUuid, trailUuid, lat, lon, accuracy, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(socket.user.uuid, trailUuid, lat, lon, accuracy ?? null, timestamp)

    io.to(`race:${trailUuid}`).emit('position_broadcast', {
      userUuid: socket.user.uuid,
      userName: user?.nombre ?? socket.user.user,
      teamName: user?.team ?? '',
      lat,
      lon,
      accuracy,
      timestamp,
    })
  })

  socket.on('disconnect', () => {
    console.log(`WS disconnect: ${socket.user?.user}`)
  })
})

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`AppRadar backend en http://localhost:${PORT}`)
})
