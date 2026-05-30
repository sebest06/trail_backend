const express = require('express')
const { authMiddleware } = require('../middleware/auth')

// Columns returned for every user in social lists
const USER_COLS = 'uuid, user, nombre, team, uuid_team, role, activityType'

function createSocialRouter(db) {
  const router = express.Router()

  // ── POST /social/follow/:userUuid ─────────────────────────────────────────
  // Follow another user. Idempotent — following twice is not an error.
  router.post('/social/follow/:userUuid', authMiddleware, (req, res) => {
    const { userUuid } = req.params
    const me = req.user.uuid

    if (userUuid === me) {
      return res.status(400).json({ error: 'No podés seguirte a vos mismo.' })
    }

    const target = db.prepare(`SELECT uuid FROM users WHERE uuid = ?`).get(userUuid)
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado.' })

    const already = db.prepare(
      'SELECT 1 FROM follows WHERE followerUuid = ? AND followedUuid = ?'
    ).get(me, userUuid)

    if (!already) {
      db.prepare(
        'INSERT INTO follows (followerUuid, followedUuid, createdAt) VALUES (?, ?, ?)'
      ).run(me, userUuid, Date.now())
    }

    res.status(already ? 200 : 201).json({ ok: true, alreadyFollowing: !!already })
  })

  // ── DELETE /social/follow/:userUuid ───────────────────────────────────────
  // Unfollow a user. Idempotent — unfollowing someone you don't follow is OK.
  router.delete('/social/follow/:userUuid', authMiddleware, (req, res) => {
    const { userUuid } = req.params
    db.prepare(
      'DELETE FROM follows WHERE followerUuid = ? AND followedUuid = ?'
    ).run(req.user.uuid, userUuid)
    res.json({ ok: true })
  })

  // ── GET /social/following ─────────────────────────────────────────────────
  // Users that I follow ("seguidos").
  router.get('/social/following', authMiddleware, (req, res) => {
    const { search } = req.query
    const me = req.user.uuid

    const rows = db.prepare(`
      SELECT u.${USER_COLS}, f.createdAt AS followedSince
      FROM follows f
      JOIN users u ON u.uuid = f.followedUuid
      WHERE f.followerUuid = ?
        ${search ? "AND (u.nombre LIKE ? OR u.user LIKE ?)" : ''}
      ORDER BY f.createdAt DESC
    `).all(me, ...(search ? [`%${search}%`, `%${search}%`] : []))

    res.json(rows)
  })

  // ── GET /social/followers ─────────────────────────────────────────────────
  // Users that follow me ("seguidores").
  router.get('/social/followers', authMiddleware, (req, res) => {
    const { search } = req.query
    const me = req.user.uuid

    const rows = db.prepare(`
      SELECT u.${USER_COLS}, f.createdAt AS followingSince
      FROM follows f
      JOIN users u ON u.uuid = f.followerUuid
      WHERE f.followedUuid = ?
        ${search ? "AND (u.nombre LIKE ? OR u.user LIKE ?)" : ''}
      ORDER BY f.createdAt DESC
    `).all(me, ...(search ? [`%${search}%`, `%${search}%`] : []))

    res.json(rows)
  })

  // ── GET /social/users ─────────────────────────────────────────────────────
  // Search/discover other users. Returns whether I already follow each one.
  // Requires ?search= (at least 2 chars) to avoid dumping the entire user table.
  router.get('/social/users', authMiddleware, (req, res) => {
    const { search } = req.query
    if (!search || search.trim().length < 2) {
      return res.status(400).json({ error: 'El parámetro search debe tener al menos 2 caracteres.' })
    }

    const me = req.user.uuid
    const like = `%${search.trim()}%`

    const rows = db.prepare(`
      SELECT u.${USER_COLS},
             CASE WHEN f.followerUuid IS NOT NULL THEN 1 ELSE 0 END AS isFollowing
      FROM users u
      LEFT JOIN follows f ON f.followerUuid = ? AND f.followedUuid = u.uuid
      WHERE u.uuid != ?
        AND (u.nombre LIKE ? OR u.user LIKE ?)
      ORDER BY u.nombre ASC
      LIMIT 50
    `).all(me, me, like, like)

    res.json(rows.map(r => ({ ...r, isFollowing: !!r.isFollowing })))
  })

  // ── GET /social/profile/:userUuid ────────────────────────────────────────
  // Get the public profile of any user by UUID (used to resolve pinned runner names).
  router.get('/social/profile/:userUuid', authMiddleware, (req, res) => {
    const user = db.prepare(`SELECT ${USER_COLS} FROM users WHERE uuid = ?`).get(req.params.userUuid)
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' })
    res.json(user)
  })

  // ── GET /social/status/:userUuid ──────────────────────────────────────────
  // Check the follow relationship between me and another user.
  router.get('/social/status/:userUuid', authMiddleware, (req, res) => {
    const { userUuid } = req.params
    const me = req.user.uuid

    const following = !!db.prepare(
      'SELECT 1 FROM follows WHERE followerUuid = ? AND followedUuid = ?'
    ).get(me, userUuid)

    const followedBy = !!db.prepare(
      'SELECT 1 FROM follows WHERE followerUuid = ? AND followedUuid = ?'
    ).get(userUuid, me)

    res.json({ following, followedBy })
  })

  return router
}

module.exports = createSocialRouter
