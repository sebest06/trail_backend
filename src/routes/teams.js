const express = require('express')
const { authMiddleware, requireRole } = require('../middleware/auth')

function createTeamsRouter(db) {
  const router = express.Router()

  router.get('/teams', (req, res) => {
    const teams = db.prepare(`SELECT DISTINCT uuid_team, team FROM users WHERE role = 'organizer'`).all()
    res.json(teams)
  })

  router.get('/team/requests', authMiddleware, requireRole('organizer'), (req, res) => {
    const requests = db.prepare(`
      SELECT uuid, user, nombre, team, role, teamStatus
      FROM users WHERE uuid_team = ? AND teamStatus = 'pending'
    `).all(req.user.uuid_team)
    res.json(requests)
  })

  router.post('/team/requests/:userUuid/accept', authMiddleware, requireRole('organizer'), (req, res) => {
    db.prepare(`UPDATE users SET teamStatus = 'accepted' WHERE uuid = ? AND uuid_team = ?`).run(req.params.userUuid, req.user.uuid_team)
    res.json({ ok: true })
  })

  router.post('/team/requests/:userUuid/reject', authMiddleware, requireRole('organizer'), (req, res) => {
    db.prepare(`UPDATE users SET teamStatus = 'rejected' WHERE uuid = ? AND uuid_team = ?`).run(req.params.userUuid, req.user.uuid_team)
    res.json({ ok: true })
  })

  return router
}

module.exports = createTeamsRouter
