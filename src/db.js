const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      uuid TEXT PRIMARY KEY,
      user TEXT UNIQUE NOT NULL,
      passw TEXT NOT NULL,
      nombre TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT '',
      uuid_team TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'runner',
      activityType TEXT NOT NULL DEFAULT 'runner',
      teamStatus TEXT DEFAULT 'accepted'
    );

    CREATE TABLE IF NOT EXISTS categories (
      categoryUuid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS users_categories (
      userUuid TEXT NOT NULL,
      categoryUuid TEXT NOT NULL,
      PRIMARY KEY (userUuid, categoryUuid)
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
      sessionUuid TEXT DEFAULT NULL,
      sos INTEGER DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS messages (
      uuid TEXT PRIMARY KEY,
      senderUuid TEXT NOT NULL,
      senderName TEXT NOT NULL,
      recipientUuid TEXT,
      teamUuid TEXT,
      trailUuid TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
      followerUuid TEXT NOT NULL,
      followedUuid TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (followerUuid, followedUuid)
    );

    CREATE TABLE IF NOT EXISTS live_preferences (
      userUuid     TEXT NOT NULL,
      trailUuid    TEXT NOT NULL,
      teamOnly     INTEGER NOT NULL DEFAULT 0,
      limitCount   INTEGER,
      pinnedUuids  TEXT NOT NULL DEFAULT '[]',
      updatedAt    INTEGER NOT NULL,
      PRIMARY KEY (userUuid, trailUuid)
    );
  `)
}

function runMigrations(db) {
  try { db.exec(`ALTER TABLE users ADD COLUMN teamStatus TEXT DEFAULT 'accepted'`) } catch (_) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN activityType TEXT DEFAULT 'runner'`) } catch (_) {}
  try { db.exec(`ALTER TABLE race_runs ADD COLUMN sos INTEGER DEFAULT 0`) } catch (_) {}
  try { db.exec(`ALTER TABLE trails ADD COLUMN teamUuid TEXT DEFAULT NULL`) } catch (_) {}
  try { db.exec(`ALTER TABLE messages ADD COLUMN teamUuid TEXT`) } catch (_) {}
  try { db.exec(`ALTER TABLE race_runs ADD COLUMN isAbandoned INTEGER DEFAULT 0`) } catch (_) {}
  try { db.exec(`ALTER TABLE race_runs ADD COLUMN sessionUuid TEXT DEFAULT NULL`) } catch (_) {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gps_user_trail_ts ON gps_positions(userUuid, trailUuid, timestamp)`)
  // Eliminar duplicados en tracks (mismo runUuid+waypointUuid con distinto trackUuid)
  // antes de crear el índice único para que la migración no falle con datos existentes
  db.exec(`
    DELETE FROM tracks WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM tracks GROUP BY runUuid, waypointUuid
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_unique_run_wp ON tracks(runUuid, waypointUuid)`)
}

function seedAdmin(db) {
  const adminExists = db.prepare('SELECT 1 FROM users WHERE user = ?').get('admin')
  if (!adminExists) {
    const hash = bcrypt.hashSync('1234', 10)
    db.prepare(`
      INSERT INTO users (uuid, user, passw, nombre, team, uuid_team, role, teamStatus)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), 'admin', hash, 'Admin User', 'Team Alpha', uuidv4(), 'superuser', 'accepted')
  } else {
    db.prepare(`UPDATE users SET role = 'superuser' WHERE user = 'admin'`).run()
  }
}

function createDb(dbPath) {
  const resolvedPath = dbPath || path.join(__dirname, '../data/appradar.db')

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createSchema(db)
  runMigrations(db)
  seedAdmin(db)

  return db
}

module.exports = { createDb }
