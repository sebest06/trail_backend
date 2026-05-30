const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'appradar-dev-secret-change-in-production'

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' })
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Sin permiso' })
    }
    next()
  }
}

module.exports = { authMiddleware, requireRole, JWT_SECRET }
