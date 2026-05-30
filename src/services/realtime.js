let _io = null

function setIo(io) {
  _io = io
}

function broadcast(room, event, data) {
  _io?.to(room).emit(event, data)
}

module.exports = { setIo, broadcast }
