const express = require('express')
const { v4: uuidv4 } = require('uuid')
const { z } = require('zod')
const { authMiddleware } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { computeRankings, latestSession } = require('../services/rankings')
const { broadcast } = require('../services/realtime')
const { COOLDOWN_MS, SESSION_WINDOW_MS, ONLINE_WINDOW_MS } = require('../constants')

const runSchema = z.object({
  runUuid: z.string().uuid('runUuid inválido'),
  trailUuid: z.string().uuid('trailUuid inválido'),
  userUuid: z.string().uuid('userUuid inválido'),
  startTime: z.number().int().positive().optional(),
  endTime: z.number().int().positive().nullable().optional(),
  totalTime: z.number().int().min(0).optional(),
  isCompleted: z.boolean().optional().default(false),
  isAbandoned: z.boolean().optional().default(false),
  sos: z.boolean().optional().default(false),
})

const trackItemSchema = z.object({
  trackUuid: z.string().uuid('trackUuid inválido'),
  runUuid: z.string().uuid('runUuid inválido'),
  waypointUuid: z.string().uuid('waypointUuid inválido'),
  trailUuid: z.string().uuid('trailUuid inválido'),
  userUuid: z.string().uuid('userUuid inválido').optional(),
  timestamp: z.number().int().positive('timestamp inválido'),
})
const tracksSchema = z.union([trackItemSchema, z.array(trackItemSchema).min(1)])

function createRacesRouter(db) {
  const router = express.Router()

  router.post('/runs/upload', authMiddleware, validate(runSchema), (req, res) => {
    const run = req.body
    const existing = db.prepare('SELECT sessionUuid, startTime, isCompleted, isAbandoned, sos FROM race_runs WHERE runUuid = ?').get(run.runUuid)
    const sessionUuid = existing?.sessionUuid || findOrCreateSession(db, run.trailUuid, run.startTime)

    if (!existing) {
      const cooldownError = checkCooldown(db, run)
      if (cooldownError) return res.status(403).json(cooldownError)
      insertRun(db, run, sessionUuid)
      // Auto-activate trail when a runner starts
      db.prepare('UPDATE trails SET isActive = 1 WHERE trailUuid = ?').run(run.trailUuid)
    } else {
      updateRun(db, run, sessionUuid, existing)
      // Auto-deactivate when every runner in the session has finished or abandoned
      if ((run.isCompleted || run.isAbandoned) && isSessionComplete(db, run.trailUuid, sessionUuid)) {
        db.prepare('UPDATE trails SET isActive = 0 WHERE trailUuid = ?').run(run.trailUuid)
      }
    }

    res.status(200).json({ ok: true, sessionUuid })

    const rankings = computeRankings(db, run.trailUuid, null, sessionUuid)
    broadcast(`race:${run.trailUuid}`, 'race_update', rankings)
    emitRaceEventIfChanged(db, run, existing)
  })

  router.post('/tracks/upload', authMiddleware, validate(tracksSchema), (req, res) => {
    const tracks = Array.isArray(req.body) ? req.body : [req.body]
    insertTracks(db, tracks, req.user.uuid)
    res.status(200).json({ ok: true })
    broadcastTrackUpdates(db, tracks)
  })

  router.get('/rankings', (req, res) => {
    const { trailUuid, teamUuid, sessionUuid: reqSession, categoryUuid } = req.query
    if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)

    try {
      const sessionUuid = reqSession || latestSession(db, trailUuid)
      let rankings = computeRankings(db, trailUuid, teamUuid || null, sessionUuid)

      if (categoryUuid) {
        const usersInCategory = db.prepare('SELECT userUuid FROM users_categories WHERE categoryUuid = ?')
          .all(categoryUuid).map(u => u.userUuid)
        rankings = rankings.filter(r => usersInCategory.includes(r.userUuid))
      }

      res.json({ data: rankings.slice(offset, offset + limit), total: rankings.length, limit, offset })
    } catch (err) {
      console.error('[rankings] error:', err)
      res.status(500).json({ error: 'Error al calcular el ranking' })
    }
  })

  router.get('/races/sessions', (req, res) => {
    const { trailUuid } = req.query
    if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100)
    const offset = Math.max(parseInt(req.query.offset) || 0, 0)

    const { total } = db.prepare(`
      SELECT COUNT(DISTINCT sessionUuid) as total FROM race_runs WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    `).get(trailUuid)

    const sessions = db.prepare(`
      SELECT sessionUuid, MIN(startTime) as startTime, COUNT(*) as runnerCount
      FROM race_runs WHERE trailUuid = ? AND sessionUuid IS NOT NULL
      GROUP BY sessionUuid ORDER BY startTime DESC
      LIMIT ? OFFSET ?
    `).all(trailUuid, limit, offset)

    res.json({ data: sessions, total, limit, offset })
  })

  router.get('/races/live', (req, res) => {
    const { trailUuid, sessionUuid: reqSession, teamUuid, limit, userUuids } = req.query
    if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })

    const sessionUuid = reqSession || latestSession(db, trailUuid)
    if (!sessionUuid) return res.json([])

    // Parse optional filters
    const maxResults  = limit    ? Math.min(Math.max(parseInt(limit) || 1, 1), 500) : null
    const pinnedUuids = userUuids
      ? String(userUuids).split(',').map(s => s.trim()).filter(Boolean)
      : []

    // Rankings ordered by race position (team-filtered when teamUuid is set).
    // This is the authoritative ordering used to pick the "top N" runners.
    const ranked = computeRankings(db, trailUuid, teamUuid || null, sessionUuid)
    const rankedUuids = ranked.map(r => r.userUuid)  // position 0 = race leader

    // Fetch all runs for the session up-front so we can check which pinned
    // runners are actually participating before calculating slot counts.
    const allRuns = db.prepare(
      'SELECT * FROM race_runs WHERE trailUuid = ? AND sessionUuid = ?'
    ).all(trailUuid, sessionUuid)

    const runnerUuidsInSession = new Set(allRuns.map(r => r.userUuid))

    // Build the set of runners whose positions to return:
    //   1. Only pinned runners PRESENT in the session occupy slots from the limit.
    //      A pinned runner who hasn't started yet doesn't consume a slot — that
    //      slot is given to the next top runner from the ranking.
    //   2. Remaining slots are filled from the top of the ranked list.
    //   3. Without a limit, return all ranked runners + all pinned runners in session.
    let selectedUuids
    if (maxResults !== null) {
      const activePinned   = pinnedUuids.filter(u => runnerUuidsInSession.has(u))
      const slotsForTop    = Math.max(0, maxResults - activePinned.length)
      const topFromRanking = rankedUuids
        .filter(u => !pinnedUuids.includes(u))
        .slice(0, slotsForTop)
      selectedUuids = new Set([...topFromRanking, ...activePinned])
    } else {
      // No limit: all ranked runners + pinned runners that are in session
      const activePinned = pinnedUuids.filter(u => runnerUuidsInSession.has(u))
      selectedUuids = new Set([...rankedUuids, ...activePinned])
    }

    // Rank-index map: used to sort the final positions by race position
    const rankMap = new Map(rankedUuids.map((uuid, i) => [uuid, i]))

    const positions = allRuns
      .filter(run => selectedUuids.has(run.userUuid))
      .map(run => resolvePosition(db, run, trailUuid))
      .filter(Boolean)
      .sort((a, b) => {
        const ra = rankMap.has(a.userUuid) ? rankMap.get(a.userUuid) : Infinity
        const rb = rankMap.has(b.userUuid) ? rankMap.get(b.userUuid) : Infinity
        return ra - rb
      })

    res.json(positions)
  })

  router.get('/races/:trailId/replay', (req, res) => {
    const { trailId } = req.params
    const { sessionUuid } = req.query

    const runs = db.prepare(`
      SELECT rr.runUuid, rr.userUuid, rr.startTime, rr.endTime, rr.isCompleted, rr.isAbandoned, rr.sos,
             u.nombre as userName, u.team as teamName, u.activityType
      FROM race_runs rr JOIN users u ON u.uuid = rr.userUuid
      WHERE rr.trailUuid = ? ${sessionUuid ? 'AND rr.sessionUuid = ?' : ''}
    `).all(trailId, ...(sessionUuid ? [sessionUuid] : []))

    if (!runs.length) return res.json({ runners: [], startTime: 0, endTime: 0 })

    const ph = runs.map(() => '?').join(',')
    const userUuids = runs.map(r => r.userUuid)

    const sessionStart = runs.reduce((min, r) => r.startTime && r.startTime < min ? r.startTime : min, Infinity)
    const lastGps = db.prepare(`SELECT MAX(timestamp) as t FROM gps_positions WHERE trailUuid = ? AND userUuid IN (${ph})`).get(trailId, ...userUuids)
    const sessionEnd = lastGps?.t || Date.now()

    const runners = runs.map(run => ({
      userUuid: run.userUuid,
      userName: run.userName,
      teamName: run.teamName,
      activityType: run.activityType || 'runner',
      isCompleted: run.isCompleted === 1,
      isAbandoned: run.isAbandoned === 1,
      sos: run.sos === 1,
      positions: db.prepare('SELECT lat, lon, timestamp FROM gps_positions WHERE userUuid = ? AND trailUuid = ? ORDER BY timestamp ASC').all(run.userUuid, trailId),
    })).filter(r => r.positions.length > 0)

    res.json({ runners, startTime: sessionStart, endTime: sessionEnd })
  })

  router.get('/races/:trailId/events', (req, res) => {
    const { sessionUuid } = req.query
    const base = `
      SELECT r.runUuid, r.userUuid, r.endTime, r.startTime, r.isCompleted, r.isAbandoned, r.sos,
             u.nombre as userName, u.team as teamName
      FROM race_runs r JOIN users u ON u.uuid = r.userUuid
      WHERE r.trailUuid = ? AND (r.isCompleted = 1 OR r.isAbandoned = 1 OR r.sos = 1)
    `
    const rows = sessionUuid
      ? db.prepare(base + ' AND r.sessionUuid = ? ORDER BY COALESCE(r.endTime, r.startTime, 0) DESC').all(req.params.trailId, sessionUuid)
      : db.prepare(base + ' ORDER BY COALESCE(r.endTime, r.startTime, 0) DESC').all(req.params.trailId)

    res.json(rows.map(e => ({
      ...e,
      type: e.sos ? 'sos' : e.isCompleted ? 'completed' : 'abandoned',
    })))
  })

  router.delete('/races/sessions/:sessionUuid', authMiddleware, (req, res) => {
    const { sessionUuid } = req.params
    const session = db.prepare('SELECT trailUuid FROM race_runs WHERE sessionUuid = ? LIMIT 1').get(sessionUuid)
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' })

    const trail = db.prepare('SELECT createdBy FROM trails WHERE trailUuid = ?').get(session.trailUuid)
    if (req.user.role !== 'superuser' && trail?.createdBy !== req.user.uuid) {
      return res.status(403).json({ error: 'Sin permiso para borrar esta sesión' })
    }

    const runs = db.prepare('SELECT runUuid, userUuid, startTime, endTime FROM race_runs WHERE sessionUuid = ?').all(sessionUuid)

    db.transaction(() => {
      for (const run of runs) {
        db.prepare('DELETE FROM tracks WHERE runUuid = ?').run(run.runUuid)
        const endBound = run.endTime || (run.startTime + 24 * 3600 * 1000)
        db.prepare('DELETE FROM gps_positions WHERE userUuid = ? AND trailUuid = ? AND timestamp >= ? AND timestamp <= ?')
          .run(run.userUuid, session.trailUuid, run.startTime, endBound)
      }
      db.prepare('DELETE FROM race_runs WHERE sessionUuid = ?').run(sessionUuid)
    })()

    res.json({ ok: true })
  })

  // ── Force-abandon helpers ─────────────────────────────────────────────────

  function getSessionTrailAndCheckPermission(sessionUuid, user, res) {
    const session = db.prepare('SELECT trailUuid FROM race_runs WHERE sessionUuid = ? LIMIT 1').get(sessionUuid)
    if (!session) { res.status(404).json({ error: 'Sesión no encontrada.' }); return null }
    const trail = db.prepare('SELECT createdBy FROM trails WHERE trailUuid = ?').get(session.trailUuid)
    if (user.role !== 'superuser' && trail?.createdBy !== user.uuid) {
      res.status(403).json({ error: 'Solo el organizador que creó la carrera o el superusuario pueden forzar el abandono.' })
      return null
    }
    return session.trailUuid
  }

  function doAbandon(runUuid, userUuid, trailUuid, sessionUuid, now) {
    db.prepare('UPDATE race_runs SET isAbandoned = 1, endTime = ? WHERE runUuid = ?').run(now, runUuid)
    if (isSessionComplete(db, trailUuid, sessionUuid)) {
      db.prepare('UPDATE trails SET isActive = 0 WHERE trailUuid = ?').run(trailUuid)
    }
    const u = db.prepare('SELECT nombre FROM users WHERE uuid = ?').get(userUuid)
    broadcast(`race:${trailUuid}`, 'race_event', {
      type: 'abandoned', userUuid, userName: u?.nombre || 'Corredor', trailUuid,
    })
  }

  // POST /races/sessions/:sessionUuid/force-abandon
  // Abandon ALL active runners in a session at once.
  router.post('/races/sessions/:sessionUuid/force-abandon', authMiddleware, (req, res) => {
    const { sessionUuid } = req.params
    const trailUuid = getSessionTrailAndCheckPermission(sessionUuid, req.user, res)
    if (!trailUuid) return

    const activeRuns = db.prepare(`
      SELECT runUuid, userUuid FROM race_runs
      WHERE sessionUuid = ? AND isCompleted = 0 AND isAbandoned = 0
    `).all(sessionUuid)

    if (activeRuns.length === 0) {
      return res.json({ ok: true, abandoned: 0, message: 'No hay corredores activos en esta sesión.' })
    }

    const now = Date.now()
    for (const run of activeRuns) {
      doAbandon(run.runUuid, run.userUuid, trailUuid, sessionUuid, now)
    }

    const rankings = computeRankings(db, trailUuid, null, sessionUuid)
    broadcast(`race:${trailUuid}`, 'race_update', rankings)

    res.json({ ok: true, abandoned: activeRuns.length })
  })

  // POST /races/sessions/:sessionUuid/runners/:userUuid/force-abandon
  // Abandon ONE specific active runner in a session.
  router.post('/races/sessions/:sessionUuid/runners/:userUuid/force-abandon', authMiddleware, (req, res) => {
    const { sessionUuid, userUuid } = req.params
    const trailUuid = getSessionTrailAndCheckPermission(sessionUuid, req.user, res)
    if (!trailUuid) return

    const run = db.prepare(`
      SELECT runUuid FROM race_runs
      WHERE sessionUuid = ? AND userUuid = ? AND isCompleted = 0 AND isAbandoned = 0
    `).get(sessionUuid, userUuid)

    if (!run) {
      return res.status(404).json({ error: 'El corredor no está activo en esta sesión o ya terminó.' })
    }

    const now = Date.now()
    doAbandon(run.runUuid, userUuid, trailUuid, sessionUuid, now)

    const rankings = computeRankings(db, trailUuid, null, sessionUuid)
    broadcast(`race:${trailUuid}`, 'race_update', rankings)

    res.json({ ok: true })
  })

  router.get('/races/:trailId/route-history/:userUuid', (req, res) => {
    const { trailId, userUuid } = req.params
    const history = db.prepare(`
      SELECT lat, lon, timestamp FROM gps_positions
      WHERE trailUuid = ? AND userUuid = ? ORDER BY timestamp ASC
    `).all(trailId, userUuid)
    res.json(history)
  })

  router.get('/races/:trailId/heatmap', (req, res) => {
    const { trailId } = req.params
    const { sessionUuid } = req.query

    let positions
    if (sessionUuid) {
      const runs = db.prepare(
        'SELECT userUuid, startTime, endTime FROM race_runs WHERE trailUuid = ? AND sessionUuid = ?'
      ).all(trailId, sessionUuid)
      if (!runs.length) return res.json([])
      positions = []
      for (const run of runs) {
        const endTs = run.endTime || Date.now()
        const pts = db.prepare(
          'SELECT lat, lon FROM gps_positions WHERE userUuid = ? AND trailUuid = ? AND timestamp >= ? AND timestamp <= ?'
        ).all(run.userUuid, trailId, run.startTime, endTs)
        positions.push(...pts)
      }
    } else {
      positions = db.prepare(
        'SELECT lat, lon FROM gps_positions WHERE trailUuid = ?'
      ).all(trailId)
    }

    res.json(positions.map(p => [p.lat, p.lon]))
  })

  router.get('/races/:trailId/gpx/:userUuid', (req, res) => {
    const { trailId, userUuid } = req.params
    const { sessionUuid } = req.query

    const user  = db.prepare('SELECT nombre FROM users WHERE uuid = ?').get(userUuid)
    const trail = db.prepare('SELECT name FROM trails WHERE trailUuid = ?').get(trailId)

    let positions
    if (sessionUuid) {
      const run = db.prepare(
        'SELECT startTime, endTime FROM race_runs WHERE trailUuid = ? AND userUuid = ? AND sessionUuid = ?'
      ).get(trailId, userUuid, sessionUuid)
      if (!run) return res.status(404).json({ error: 'Carrera no encontrada' })
      const endTs = run.endTime || Date.now()
      positions = db.prepare(
        'SELECT lat, lon, timestamp FROM gps_positions WHERE userUuid = ? AND trailUuid = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC'
      ).all(userUuid, trailId, run.startTime, endTs)
    } else {
      positions = db.prepare(
        'SELECT lat, lon, timestamp FROM gps_positions WHERE userUuid = ? AND trailUuid = ? ORDER BY timestamp ASC'
      ).all(userUuid, trailId)
    }

    const escape = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))
    const trailName  = escape(trail?.name  || 'Carrera')
    const runnerName = escape(user?.nombre || 'Corredor')
    const trkpts = positions.map(p =>
      `      <trkpt lat="${p.lat}" lon="${p.lon}"><time>${new Date(p.timestamp).toISOString()}</time></trkpt>`
    ).join('\n')

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AppRadar" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${trailName} — ${runnerName}</name></metadata>
  <trk>
    <name>${trailName} — ${runnerName}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`

    const slug = s => s.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-]/g, '')
    res.setHeader('Content-Type', 'application/gpx+xml')
    res.setHeader('Content-Disposition', `attachment; filename="${slug(trail?.name || 'carrera')}_${slug(user?.nombre || 'corredor')}.gpx"`)
    res.send(gpx)
  })

  return router
}

// Returns true when every runner in a session has either completed or abandoned.
function isSessionComplete(db, trailUuid, sessionUuid) {
  if (!sessionUuid) return true
  const { count } = db.prepare(`
    SELECT COUNT(*) as count FROM race_runs
    WHERE trailUuid = ? AND sessionUuid = ? AND isCompleted = 0 AND isAbandoned = 0
  `).get(trailUuid, sessionUuid)
  return count === 0
}

function findOrCreateSession(db, trailUuid, startTime) {
  const ts = startTime || Date.now()
  const row = db.prepare(`
    SELECT sessionUuid, MIN(startTime) as sessionStart
    FROM race_runs
    WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    GROUP BY sessionUuid
    HAVING sessionStart >= ? AND sessionStart <= ?
    ORDER BY sessionStart DESC LIMIT 1
  `).get(trailUuid, ts - SESSION_WINDOW_MS, ts + SESSION_WINDOW_MS)

  // Only join an existing session if it still has active runners.
  // If the session is complete (all done), create a new one even within the time window.
  if (row?.sessionUuid && !isSessionComplete(db, trailUuid, row.sessionUuid)) {
    return row.sessionUuid
  }
  return uuidv4()
}

function checkCooldown(db, run) {
  const currentSession = latestSession(db, run.trailUuid)

  // No previous session, or all runners already finished → allow
  if (!currentSession || isSessionComplete(db, run.trailUuid, currentSession)) return null

  // Active session: check if the join window is still open.
  const sessionStart = db.prepare(
    'SELECT MIN(startTime) as t FROM race_runs WHERE sessionUuid = ?'
  ).get(currentSession)?.t ?? Date.now()

  const sessionAge = (run.startTime || Date.now()) - sessionStart
  // COOLDOWN_MS=0 means no time restriction (testing mode), window is always open
  const joinWindowOpen = COOLDOWN_MS === 0 || sessionAge < COOLDOWN_MS

  if (joinWindowOpen) {
    // A runner already in this session cannot start a second run on the same trail
    const alreadyIn = db.prepare(
      'SELECT 1 FROM race_runs WHERE sessionUuid = ? AND userUuid = ?'
    ).get(currentSession, run.userUuid)
    if (!alreadyIn) return null  // New runner joining within the window → OK
    return { error: 'Ya estás participando en esta carrera activa. Esperá a que todos terminen para empezar una nueva.' }
  }

  // Join window expired: race is closed for new entrants until everyone finishes
  return { error: 'La carrera ya cerró el ingreso de nuevos corredores. Esperá a que todos finalicen para empezar una nueva.' }
}

function insertRun(db, run, sessionUuid) {
  db.prepare(`
    INSERT INTO race_runs (runUuid, trailUuid, userUuid, startTime, endTime, totalTime, isCompleted, isAbandoned, sessionUuid, sos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runUuid, run.trailUuid, run.userUuid, run.startTime, run.endTime,
    run.totalTime, run.isCompleted ? 1 : 0, run.isAbandoned ? 1 : 0, sessionUuid, run.sos ? 1 : 0
  )
}

function updateRun(db, run, sessionUuid, existing) {
  db.prepare(`
    UPDATE race_runs SET sessionUuid=?, isCompleted=?, isAbandoned=?, startTime=?, endTime=?, totalTime=?, sos=?
    WHERE runUuid=?
  `).run(
    sessionUuid, run.isCompleted ? 1 : 0, run.isAbandoned ? 1 : 0,
    run.startTime || existing.startTime, run.endTime, run.totalTime, run.sos ? 1 : 0, run.runUuid
  )
}

function emitRaceEventIfChanged(db, run, existing) {
  if (!run.isCompleted && !run.isAbandoned && !run.sos) return
  if (existing) {
    const unchanged =
      !!existing.isCompleted === !!run.isCompleted &&
      !!existing.isAbandoned === !!run.isAbandoned &&
      !!existing.sos === !!run.sos
    if (unchanged) return
  }
  const user = db.prepare('SELECT nombre FROM users WHERE uuid = ?').get(run.userUuid)
  broadcast(`race:${run.trailUuid}`, 'race_event', {
    type: run.sos ? 'sos' : (run.isCompleted ? 'completed' : 'abandoned'),
    userUuid: run.userUuid,
    userName: user?.nombre || 'Corredor',
    trailUuid: run.trailUuid,
  })
}

function insertTracks(db, tracks, defaultUserUuid) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tracks (trackUuid, runUuid, waypointUuid, trailUuid, userUuid, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  db.transaction((items) => {
    for (const t of items) {
      insert.run(t.trackUuid, t.runUuid, t.waypointUuid, t.trailUuid, t.userUuid || defaultUserUuid, t.timestamp)
    }
  })(tracks)
}

function broadcastTrackUpdates(db, tracks) {
  const affectedTrails = [...new Set(tracks.map(t => t.trailUuid).filter(Boolean))]
  for (const trailUuid of affectedTrails) {
    const firstTrack = tracks.find(t => t.trailUuid === trailUuid)
    const sessionRow = firstTrack
      ? db.prepare('SELECT sessionUuid FROM race_runs WHERE runUuid = ?').get(firstTrack.runUuid)
      : null
    const rankings = computeRankings(db, trailUuid, null, sessionRow?.sessionUuid ?? null)
    broadcast(`race:${trailUuid}`, 'race_update', rankings)

    // Also broadcast an updated position for each runner who just hit a waypoint
    // so the map reflects the new position immediately (without waiting for the GPS poll)
    const affectedRunUuids = [...new Set(tracks.filter(t => t.trailUuid === trailUuid).map(t => t.runUuid))]
    for (const runUuid of affectedRunUuids) {
      const run = db.prepare('SELECT * FROM race_runs WHERE runUuid = ?').get(runUuid)
      if (!run) continue
      const pos = resolvePosition(db, run, trailUuid)
      if (!pos) continue
      broadcast(`race:${trailUuid}`, 'position_broadcast', pos)
    }
  }
}

function resolvePosition(db, run, trailUuid) {
  const user = db.prepare('SELECT nombre, team, activityType FROM users WHERE uuid = ?').get(run.userUuid)

  const gps = db.prepare(`
    SELECT lat, lon, timestamp FROM gps_positions
    WHERE userUuid = ? AND trailUuid = ? ORDER BY timestamp DESC LIMIT 1
  `).get(run.userUuid, trailUuid)

  const lastWp = db.prepare(`
    SELECT w.lat, w.lon, t.timestamp
    FROM tracks t JOIN waypoints w ON w.waypointUuid = t.waypointUuid
    WHERE t.runUuid = ? AND t.trailUuid = ? ORDER BY t.timestamp DESC LIMIT 1
  `).get(run.runUuid, trailUuid)

  const now = Date.now()
  const gpsTs = gps?.timestamp ?? 0
  const wpTs = lastWp?.timestamp ?? 0

  // Use whichever data is more recent: GPS position or last waypoint reached.
  // This ensures that when a runner passes a waypoint after their last GPS update,
  // the map shows them AT the waypoint rather than at the previous GPS position.
  if (wpTs > gpsTs) {
    const isOnline = (now - wpTs) <= ONLINE_WINDOW_MS
    return buildPosition(run, user, lastWp, isOnline)
  }

  if (gps) {
    const isOnline = (now - gpsTs) <= ONLINE_WINDOW_MS
    return buildPosition(run, user, gps, isOnline)
  }

  return null
}

function buildPosition(run, user, location, isOnline) {
  return {
    userUuid: run.userUuid,
    userName: user?.nombre ?? 'Desconocido',
    teamName: user?.team ?? '',
    activityType: user?.activityType || 'runner',
    sos: run.sos === 1,
    lat: location.lat,
    lon: location.lon,
    timestamp: location.timestamp,
    isOnline
  }
}

module.exports = createRacesRouter
