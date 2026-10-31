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

function revokeUserSessions(userId) {
  for (const [token, user] of sessions) {
    if (user.id === userId) sessions.delete(token)
  }
}

function updateUserSessions(updatedUser) {
  for (const [token, user] of sessions) {
    if (user.id === updatedUser.id) sessions.set(token, updatedUser)
  }
}

module.exports = { findSession, login, revokeUserSessions, updateUserSessions }
