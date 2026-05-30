const express = require('express')
const { z } = require('zod')
const { authMiddleware } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

const DEFAULT_PREFS = { teamOnly: false, limit: null, pinnedUuids: [] }

const prefsSchema = z.object({
  teamOnly:    z.boolean().optional().default(false),
  limit:       z.number().int().min(1).max(500).nullable().optional().default(null),
  pinnedUuids: z.array(z.string().uuid('UUID inválido en pinnedUuids')).max(50).optional().default([]),
})

function parsePrefs(row, teamUuid) {
  const pinnedUuids = JSON.parse(row.pinnedUuids || '[]')
  return {
    teamOnly:    !!row.teamOnly,
    limit:       row.limitCount ?? null,
    pinnedUuids,
    updatedAt:   row.updatedAt,
    // Convenience: ready-to-use query params for GET /races/live
    queryParams: buildQueryParams(!!row.teamOnly, teamUuid, row.limitCount ?? null, pinnedUuids),
  }
}

function buildQueryParams(teamOnly, teamUuid, limit, pinnedUuids) {
  const p = {}
  if (teamOnly && teamUuid) p.teamUuid = teamUuid
  if (limit !== null)       p.limit    = limit
  if (pinnedUuids.length)   p.userUuids = pinnedUuids.join(',')
  return p
}

function createLivePreferencesRouter(db) {
  const router = express.Router()

  // ── GET /live-preferences — list all saved preferences for the current user ──
  router.get('/live-preferences', authMiddleware, (req, res) => {
    const rows = db.prepare(
      'SELECT trailUuid, teamOnly, limitCount, pinnedUuids, updatedAt FROM live_preferences WHERE userUuid = ? ORDER BY updatedAt DESC'
    ).all(req.user.uuid)

    const teamUuid = req.user.uuid_team ?? null
    res.json(rows.map(row => ({ trailUuid: row.trailUuid, ...parsePrefs(row, teamUuid) })))
  })

  // ── GET /live-preferences/:trailUuid — get preferences for one trail ─────────
  router.get('/live-preferences/:trailUuid', authMiddleware, (req, res) => {
    const row = db.prepare(
      'SELECT teamOnly, limitCount, pinnedUuids, updatedAt FROM live_preferences WHERE userUuid = ? AND trailUuid = ?'
    ).get(req.user.uuid, req.params.trailUuid)

    const teamUuid = req.user.uuid_team ?? null

    if (!row) {
      return res.json({
        ...DEFAULT_PREFS,
        updatedAt: null,
        queryParams: buildQueryParams(false, teamUuid, null, []),
      })
    }

    res.json(parsePrefs(row, teamUuid))
  })

  // ── PUT /live-preferences/:trailUuid — save / update preferences ─────────────
  router.put('/live-preferences/:trailUuid', authMiddleware, validate(prefsSchema), (req, res) => {
    const { trailUuid } = req.params
    const { teamOnly, limit, pinnedUuids } = req.body

    // Verify trail exists
    const trail = db.prepare('SELECT 1 FROM trails WHERE trailUuid = ?').get(trailUuid)
    if (!trail) return res.status(404).json({ error: 'Trail no encontrado.' })

    const now = Date.now()
    db.prepare(`
      INSERT INTO live_preferences (userUuid, trailUuid, teamOnly, limitCount, pinnedUuids, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(userUuid, trailUuid) DO UPDATE SET
        teamOnly    = excluded.teamOnly,
        limitCount  = excluded.limitCount,
        pinnedUuids = excluded.pinnedUuids,
        updatedAt   = excluded.updatedAt
    `).run(
      req.user.uuid, trailUuid,
      teamOnly ? 1 : 0,
      limit ?? null,
      JSON.stringify(pinnedUuids ?? []),
      now
    )

    const teamUuid = req.user.uuid_team ?? null
    res.json({
      ok: true,
      teamOnly:    !!teamOnly,
      limit:       limit ?? null,
      pinnedUuids: pinnedUuids ?? [],
      updatedAt:   now,
      queryParams: buildQueryParams(!!teamOnly, teamUuid, limit ?? null, pinnedUuids ?? []),
    })
  })

  // ── DELETE /live-preferences/:trailUuid — reset to defaults ──────────────────
  router.delete('/live-preferences/:trailUuid', authMiddleware, (req, res) => {
    db.prepare(
      'DELETE FROM live_preferences WHERE userUuid = ? AND trailUuid = ?'
    ).run(req.user.uuid, req.params.trailUuid)
    res.json({ ok: true })
  })

  return router
}

module.exports = createLivePreferencesRouter
