const express = require('express')
const { z } = require('zod')
const { v4: uuidv4 } = require('uuid')
const { authMiddleware } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { broadcast } = require('../services/realtime')

const sendSchema = z.object({
  trailUuid: z.string().uuid('trailUuid inválido'),
  recipientUuid: z.string().uuid('recipientUuid inválido').nullable().optional(),
  content: z.string().min(1, 'El mensaje no puede estar vacío').max(500, 'Máximo 500 caracteres'),
})

function createMessagesRouter(db) {
  const router = express.Router()

  router.post('/messages', authMiddleware, validate(sendSchema), (req, res) => {
    if (req.user.role !== 'organizer' && req.user.role !== 'superuser') {
      return res.status(403).json({ error: 'Solo los organizadores pueden enviar mensajes' })
    }
    const { trailUuid, recipientUuid, content } = req.body
    const sender = db.prepare('SELECT nombre, uuid_team FROM users WHERE uuid = ?').get(req.user.uuid)
    const timestamp = Date.now()
    const messageUuid = uuidv4()
    db.prepare(`
      INSERT INTO messages (uuid, senderUuid, senderName, recipientUuid, teamUuid, trailUuid, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(messageUuid, req.user.uuid, sender?.nombre ?? 'Organizador', recipientUuid ?? null, sender?.uuid_team ?? null, trailUuid, content, timestamp)

    // Emit via Socket.IO so connected clients receive the message instantly.
    // The client is responsible for filtering by recipientUuid and senderUuid.
    broadcast(`race:${trailUuid}`, 'new_message', {
      uuid: messageUuid,
      senderUuid: req.user.uuid,
      senderName: sender?.nombre ?? 'Organizador',
      recipientUuid: recipientUuid ?? null,
      teamUuid: sender?.uuid_team ?? null,
      trailUuid,
      content,
      timestamp,
    })

    res.json({ ok: true })
  })

  router.get('/messages', authMiddleware, (req, res) => {
    const { trailUuid, since } = req.query
    if (!trailUuid) return res.status(400).json({ error: 'trailUuid requerido' })
    const sinceTs = parseInt(since) || 0
    const userTeamUuid = req.user.uuid_team ?? null
    const messages = db.prepare(`
      SELECT uuid, senderUuid, senderName, recipientUuid, trailUuid, content, timestamp
      FROM messages
      WHERE trailUuid = ? AND timestamp > ?
        AND senderUuid != ?
        AND (
          recipientUuid = ?
          OR (recipientUuid IS NULL AND teamUuid = ?)
        )
      ORDER BY timestamp ASC
    `).all(trailUuid, sinceTs, req.user.uuid, req.user.uuid, userTeamUuid)
    res.json(messages)
  })

  return router
}

module.exports = createMessagesRouter
