const express = require('express')
const { z } = require('zod')
const { authMiddleware } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { broadcast } = require('../services/realtime')

const gpsSchema = z.object({
  trailUuid: z.string().uuid('trailUuid inválido'),
  lat: z.number({ message: 'lat debe ser un número' }).min(-90, 'lat fuera de rango').max(90, 'lat fuera de rango'),
  lon: z.number({ message: 'lon debe ser un número' }).min(-180, 'lon fuera de rango').max(180, 'lon fuera de rango'),
  accuracy: z.number().positive().optional(),
  timestamp: z.number().int().positive().optional(),
  activityType: z.enum(['runner', 'bike', 'car']).optional(),
})

function createGpsRouter(db) {
  const router = express.Router()

  router.post('/gps/upload', authMiddleware, validate(gpsSchema), (req, res) => {
    const { trailUuid, lat, lon, accuracy, timestamp, activityType } = req.body

    const ts = timestamp || Date.now()

    if (activityType) {
      db.prepare('UPDATE users SET activityType = ? WHERE uuid = ?').run(activityType, req.user.uuid)
    }

    db.prepare(`
      INSERT INTO gps_positions (userUuid, trailUuid, lat, lon, accuracy, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.uuid, trailUuid, lat, lon, accuracy ?? null, ts)

    const user = db.prepare('SELECT nombre, team, activityType FROM users WHERE uuid = ?').get(req.user.uuid)
    const run = db.prepare(
      'SELECT sos FROM race_runs WHERE userUuid = ? AND trailUuid = ? AND isCompleted = 0 AND isAbandoned = 0'
    ).get(req.user.uuid, trailUuid)

    broadcast(`race:${trailUuid}`, 'position_broadcast', {
      userUuid: req.user.uuid,
      userName: user?.nombre ?? req.user.user,
      teamName: user?.team ?? '',
      activityType: user?.activityType || 'runner',
      sos: run?.sos === 1,
      lat, lon, accuracy, timestamp: ts,
      isOnline: true,
    })

    res.status(200).json({ ok: true })
  })

  return router
}

module.exports = createGpsRouter
