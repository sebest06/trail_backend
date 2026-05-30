require('dotenv').config()

const { createServer } = require('http')
const { createDb } = require('./src/db')
const { createApp, CORS_ORIGINS } = require('./app')
const setupSocket = require('./src/socket')

const PORT = process.env.PORT || 3000
const dbPath = process.env.DATABASE_PATH || undefined

const db = createDb(dbPath)
const app = createApp(db)
const httpServer = createServer(app)

setupSocket(httpServer, db, CORS_ORIGINS)

httpServer.listen(PORT, () => {
  console.log(`AppRadar backend en http://localhost:${PORT}`)
})
