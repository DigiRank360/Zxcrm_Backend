const authService = require('../services/authService')

function authenticate(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '')
  const user = authService.findSession(token)
  if (!user) return res.status(401).json({ error: 'Sign in again to continue.' })
  req.user = user
  next()
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' })
    }
    next()
  }
}

module.exports = { allowRoles, authenticate }
