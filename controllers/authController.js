const authService = require('../services/authService')
const userModel = require('../models/userModel')
const config = require('../config')

async function login(req, res, next) {
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' })
  }
  try {
    const result = await authService.login(username, password)
    if (!result) return res.status(401).json({ error: 'Invalid ID or password.' })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

function me(req, res) {
  res.json({ user: req.user })
}

async function setupStatus(req, res, next) {
  try {
    const users = await userModel.findAll()
    const configured = users.some((user) => user.role === 'admin') ||
      Boolean(config.admin.username && config.admin.password)
    res.json({ configured, message: configured ? undefined : 'Set ADMIN_USERNAME and ADMIN_PASSWORD before first startup.' })
  } catch (error) {
    next(error)
  }
}

module.exports = { login, me, setupStatus }
