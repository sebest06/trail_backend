function latestSession(db, trailUuid) {
  const row = db.prepare(`
    SELECT sessionUuid FROM race_runs
    WHERE trailUuid = ? AND sessionUuid IS NOT NULL
    GROUP BY sessionUuid ORDER BY MAX(startTime) DESC LIMIT 1
  `).get(trailUuid)
  return row?.sessionUuid ?? null
}

function computeRankings(db, trailUuid, teamUuid, sessionUuid = null) {
  const runs = queryRuns(db, trailUuid, teamUuid, sessionUuid)
  if (!runs.length) return []

  const totalWaypoints = db.prepare('SELECT COUNT(*) as c FROM waypoints WHERE trailUuid = ?').get(trailUuid)?.c ?? 0
  const waypoints = db.prepare('SELECT waypointUuid, "order", name FROM waypoints WHERE trailUuid = ? ORDER BY "order"').all(trailUuid)

  const runUuids = runs.map(r => r.runUuid)
  const userUuids = [...new Set(runs.map(r => r.userUuid))]
  const ph = arr => arr.map(() => '?').join(',')

  const userMap = new Map(
    db.prepare(`SELECT uuid, nombre, team, activityType FROM users WHERE uuid IN (${ph(userUuids)})`)
      .all(...userUuids).map(u => [u.uuid, u])
  )

  const statsMap = new Map(
    db.prepare(`
      SELECT runUuid, COUNT(DISTINCT waypointUuid) as reached, MAX(timestamp) as lastTs
      FROM tracks WHERE trailUuid = ? AND runUuid IN (${ph(runUuids)})
      GROUP BY runUuid
    `).all(trailUuid, ...runUuids).map(s => [s.runUuid, s])
  )

  const allWpTimes = db.prepare(`
    SELECT runUuid, waypointUuid, MIN(timestamp) as timestamp
    FROM tracks WHERE trailUuid = ? AND runUuid IN (${ph(runUuids)})
    GROUP BY runUuid, waypointUuid
  `).all(trailUuid, ...runUuids)

  const wpTimesMap = new Map()
  for (const t of allWpTimes) {
    if (!wpTimesMap.has(t.runUuid)) wpTimesMap.set(t.runUuid, [])
    wpTimesMap.get(t.runUuid).push(t)
  }

  const wpByUuid = new Map(waypoints.map(w => [w.waypointUuid, w]))

  const rankings = runs.map(run => {
    const user = userMap.get(run.userUuid)
    const stats = statsMap.get(run.runUuid) || { reached: 0, lastTs: 0 }
    const runWpTimes = (wpTimesMap.get(run.runUuid) || []).sort((a, b) => a.timestamp - b.timestamp)

    const waypointTimes = runWpTimes.map(t => ({
      waypointUuid: t.waypointUuid,
      timestamp: t.timestamp,
      timeFromStart: t.timestamp - run.startTime,
    }))

    const maxOrder = runWpTimes.reduce((max, t) => Math.max(max, wpByUuid.get(t.waypointUuid)?.order ?? -1), -1)
    const nextWp = waypoints.find(w => w.order > maxOrder)
    const nextWaypoint = nextWp
      ? (nextWp.name || `WP ${nextWp.order}`)
      : (run.isCompleted ? 'Finalizado' : '---')

    // ETA: solo para corredores activos con al menos 1 waypoint alcanzado
    let eta = null
    const reached = stats.reached ?? 0
    const isActive = !run.isCompleted && !run.isAbandoned
    if (isActive && reached > 0 && totalWaypoints > reached) {
      const lastTs = stats.lastTs
      const firstTs = runWpTimes[0]?.timestamp ?? run.startTime
      const avgPaceMs = reached >= 2
        ? (lastTs - firstTs) / (reached - 1)
        : (lastTs - run.startTime)
      const remaining = totalWaypoints - reached
      eta = lastTs + remaining * avgPaceMs
    }

    return {
      userUuid: run.userUuid,
      userName: user?.nombre ?? 'Desconocido',
      teamName: user?.team ?? '',
      waypointsReached: stats.reached,
      totalWaypoints,
      lastWaypointTime: stats.lastTs ?? 0,
      totalTime: run.totalTime,
      isCompleted: run.isCompleted === 1,
      isAbandoned: run.isAbandoned === 1,
      sos: run.sos === 1,
      activityType: user?.activityType || 'runner',
      waypointTimes,
      nextWaypoint,
      eta,
    }
  })

  rankings.sort((a, b) => {
    if (b.waypointsReached !== a.waypointsReached) return b.waypointsReached - a.waypointsReached
    return a.lastWaypointTime - b.lastWaypointTime
  })

  return rankings
}

function queryRuns(db, trailUuid, teamUuid, sessionUuid) {
  if (sessionUuid && teamUuid) {
    return db.prepare(`
      SELECT rr.* FROM race_runs rr JOIN users u ON rr.userUuid = u.uuid
      WHERE rr.trailUuid = ? AND rr.sessionUuid = ? AND u.uuid_team = ?
    `).all(trailUuid, sessionUuid, teamUuid)
  }
  if (sessionUuid) {
    return db.prepare('SELECT * FROM race_runs WHERE trailUuid = ? AND sessionUuid = ?').all(trailUuid, sessionUuid)
  }
  if (teamUuid) {
    return db.prepare(`
      SELECT rr.* FROM race_runs rr JOIN users u ON rr.userUuid = u.uuid
      WHERE rr.trailUuid = ? AND u.uuid_team = ?
    `).all(trailUuid, teamUuid)
  }
  return db.prepare('SELECT * FROM race_runs WHERE trailUuid = ?').all(trailUuid)
}

module.exports = { computeRankings, latestSession }
