const { Server } = require('socket.io')
const jwt = require('jsonwebtoken')
const { JWT_SECRET } = require('./middleware/auth')
const { setIo } = require('./services/realtime')

function setupSocket(httpServer, db, corsOrigins) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
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

    socket.on('join_race', ({ trailUuid }) => socket.join(`race:${trailUuid}`))
    socket.on('leave_race', ({ trailUuid }) => socket.leave(`race:${trailUuid}`))

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
        lat, lon, accuracy, timestamp,
      })
    })

    socket.on('disconnect', () => console.log(`WS disconnect: ${socket.user?.user}`))
  })

  setIo(io)
  return io
}

module.exports = setupSocket
