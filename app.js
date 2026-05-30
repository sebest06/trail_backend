require('dotenv').config()

const express = require('express')
const cors = require('cors')
const path = require('path')

const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:4173']

const IS_PROD = process.env.NODE_ENV === 'production'

function createApp(db) {
  const app = express()

  if (!IS_PROD) {
    app.use(cors({ origin: CORS_ORIGINS, credentials: true }))
  }

  app.use(express.json())

  // Serve frontend build in production
  if (IS_PROD) {
    app.use(express.static(path.join(__dirname, 'public')))
  }

  app.get('/health', (req, res) => res.json({ ok: true }))

  app.use('/auth', require('./src/routes/auth')(db))
  app.use(require('./src/routes/teams')(db))
  app.use(require('./src/routes/trails')(db))
  app.use(require('./src/routes/races')(db))
  app.use(require('./src/routes/gps')(db))
  app.use(require('./src/routes/messages')(db))
  app.use(require('./src/routes/social')(db))
  app.use(require('./src/routes/livePreferences')(db))

  // SPA fallback — must come after all API routes
  if (IS_PROD) {
    app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))
  }

  return app
}

module.exports = { createApp, CORS_ORIGINS }
