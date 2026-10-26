const userModel = require('../models/userModel')
const { isValidUsername } = require('../utils/username')

async function list(req, res, next) {
  try {
    res.json(await userModel.findAll())
  } catch (error) {
    next(error)
  }
}

async function create(req, res, next) {
  const { name, username, password, role, phone } = req.body || {}
  if (typeof name !== 'string' || !name.trim() ||
      !isValidUsername(username) ||
      typeof password !== 'string' || password.length < 12 ||
      !['employee', 'technician'].includes(role) ||
      (phone !== undefined && typeof phone !== 'string')) {
    return res.status(400).json({
      error: 'Provide a name, a 3–40 character login ID (email-style IDs are supported), a password of at least 12 characters, and role employee or technician.',
    })
  }
  try {
    res.status(201).json(await userModel.create({ name, username, password, role, phone }))
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message })
    next(error)
  }
}

module.exports = { create, list }
