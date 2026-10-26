const crypto = require('node:crypto')
const userModel = require('../models/userModel')

const sessions = new Map()

async function login(username, password) {
  const account = await userModel.findByUsername(username)
  if (!account || !await userModel.verifyPassword(password, account.passwordHash)) return null
  const user = userModel.publicUser(account)
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, user)
  return { user, token }
}

function findSession(token) {
  return token ? sessions.get(token) : undefined
}

module.exports = { findSession, login }
