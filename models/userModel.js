const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const crypto = require('node:crypto')
const config = require('../config')
const User = require('./User')
const { isValidUsername } = require('../utils/username')

const scrypt = promisify(crypto.scrypt)
const usersFile = config.usersFile
const SALT_BYTES = 16
const KEY_BYTES = 64

async function readUsers() {
  try {
    return JSON.parse(await fs.readFile(usersFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

let pendingWrite = Promise.resolve()
async function writeUsers(users) {
  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(usersFile), { recursive: true })
    const tempFile = `${usersFile}.tmp`
    await fs.writeFile(tempFile, JSON.stringify(users, null, 2), { mode: 0o600 })
    await fs.rename(tempFile, usersFile)
  })
  return pendingWrite
}

function publicUser(user) {
  const { passwordHash, ...safeUser } = user
  return safeUser
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

async function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = (storedHash || '').split(':')
  if (!saltHex || !keyHex) return false
  const expected = Buffer.from(keyHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

async function initializeAdmin() {
  if (!config.localTestStorage) {
    const existingAdmin = await User.exists({ role: 'admin' })
    if (existingAdmin) return
    const username = config.admin.username?.trim().toLowerCase()
    const password = config.admin.password
    if (!username || !password) {
      throw new Error('No admin account exists. Set ADMIN_USERNAME and ADMIN_PASSWORD in Crm_Backend/.env before starting.')
    }
    if (!isValidUsername(username)) {
      throw new Error('ADMIN_USERNAME must be a 3–40 character login ID (email-style IDs are supported).')
    }
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.')
    await User.create({
      id: crypto.randomUUID(),
      name: config.admin.name?.trim() || 'Administrator',
      username,
      role: 'admin',
      active: true,
      phone: '',
      passwordHash: await hashPassword(password),
    })
    return
  }
  const users = await readUsers()
  if (users.some((user) => user.role === 'admin')) return
  const username = config.admin.username?.trim().toLowerCase()
  const password = config.admin.password
  if (!username || !password) return
  if (!isValidUsername(username)) {
    throw new Error('ADMIN_USERNAME must be a 3–40 character login ID (email-style IDs are supported).')
  }
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.')
  const id = crypto.randomUUID()
  users.push({
    id,
    name: config.admin.name?.trim() || 'Administrator',
    username,
    role: 'admin',
    active: true,
    phone: '',
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  })
  await writeUsers(users)
}

async function findByUsername(username) {
  if (!config.localTestStorage) {
    const user = await User.findOne({
      username: username.trim().toLowerCase(),
      active: true,
      deletedAt: { $exists: false },
    })
      .select('+passwordHash')
      .lean()
    return user || null
  }
  const users = await readUsers()
  return users.find((user) => user.username === username.trim().toLowerCase() && user.active !== false && !user.deletedAt) || null
}

async function findAll({ includeInactive = false } = {}) {
  if (!config.localTestStorage) {
    const users = await User.find(includeInactive ? {} : { active: true, deletedAt: { $exists: false } }).lean()
    return users.map(publicUser)
  }
  return (await readUsers()).filter((user) => includeInactive || (user.active !== false && !user.deletedAt)).map(publicUser)
}

async function create({ name, username, password, role, phone = '', maxOpenLeads, serviceAreas = [], propertyTypes = [], minLeadScore, maxLeadScore }) {
  const routing = {
    ...(maxOpenLeads !== undefined ? { maxOpenLeads: Number(maxOpenLeads) } : {}),
    serviceAreas: serviceAreas.map((item) => item.trim()),
    propertyTypes: propertyTypes.map((item) => item.trim()),
    ...(minLeadScore !== undefined ? { minLeadScore: Number(minLeadScore) } : {}),
    ...(maxLeadScore !== undefined ? { maxLeadScore: Number(maxLeadScore) } : {}),
  }
  if (!config.localTestStorage) {
    const normalizedUsername = username.trim().toLowerCase()
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      username: normalizedUsername,
      role,
      phone: phone.trim(),
      active: true,
      ...(role === 'employee' ? routing : {}),
      passwordHash: await hashPassword(password),
    }
    try {
      const created = await User.create(user)
      return publicUser(created.toObject())
    } catch (error) {
      if (error.code === 11000) {
        const conflict = new Error('That user ID is already in use.')
        conflict.status = 409
        throw conflict
      }
      throw error
    }
  }
  const users = await readUsers()
  const normalizedUsername = username.trim().toLowerCase()
  if (users.some((user) => user.username === normalizedUsername)) {
    const error = new Error('That user ID is already in use.')
    error.status = 409
    throw error
  }
  const user = {
    id: crypto.randomUUID(),
    name: name.trim(),
    username: normalizedUsername,
    role,
    phone: phone.trim(),
    active: true,
    ...(role === 'employee' ? routing : {}),
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  }
  users.push(user)
  await writeUsers(users)
  return publicUser(user)
}

async function updateRouting(id, updates) {
  if (!config.localTestStorage) {
    const user = await User.findOneAndUpdate({ id, role: 'employee', deletedAt: { $exists: false } }, { $set: updates }, { new: true, runValidators: true }).lean()
    return user ? publicUser(user) : null
  }
  const users = await readUsers()
  const user = users.find((item) => item.id === id && item.role === 'employee' && !item.deletedAt)
  if (!user) return null
  Object.assign(user, updates)
  await writeUsers(users)
  return publicUser(user)
}

async function updateProfile(id, updates) {
  const { password, ...profile } = updates
  if (password) profile.passwordHash = await hashPassword(password)
  const unset = {}
  for (const key of ['maxOpenLeads', 'minLeadScore', 'maxLeadScore']) {
    if (profile[key] === null) {
      delete profile[key]
      unset[key] = 1
    }
  }
  if (!config.localTestStorage) {
    const user = await User.findOneAndUpdate(
      { id, role: { $in: ['employee', 'technician', 'hr'] }, deletedAt: { $exists: false } },
      { $set: profile, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { new: true, runValidators: true },
    ).lean()
    return user ? publicUser(user) : null
  }
  const users = await readUsers()
  const user = users.find((item) => item.id === id && ['employee', 'technician', 'hr'].includes(item.role) && !item.deletedAt)
  if (!user) return null
  Object.assign(user, profile)
  for (const key of Object.keys(unset)) delete user[key]
  await writeUsers(users)
  return publicUser(user)
}

async function softDelete(id) {
  if (!config.localTestStorage) {
    const user = await User.findOneAndUpdate(
      { id, role: { $in: ['employee', 'technician', 'hr'] }, deletedAt: { $exists: false } },
      { $set: { active: false, deletedAt: new Date() } },
      { new: true, runValidators: true },
    ).lean()
    return user ? publicUser(user) : null
  }
  const users = await readUsers()
  const user = users.find((item) => item.id === id && ['employee', 'technician', 'hr'].includes(item.role) && !item.deletedAt)
  if (!user) return null
  user.active = false
  user.deletedAt = new Date().toISOString()
  await writeUsers(users)
  return publicUser(user)
}

async function restore(id) {
  if (!config.localTestStorage) {
    const user = await User.findOneAndUpdate(
      { id, role: { $in: ['employee', 'technician', 'hr'] }, deletedAt: { $exists: true } },
      { $set: { active: true }, $unset: { deletedAt: 1 } },
      { new: true, runValidators: true },
    ).lean()
    return user ? publicUser(user) : null
  }
  const users = await readUsers()
  const user = users.find((item) => item.id === id && ['employee', 'technician', 'hr'].includes(item.role) && item.deletedAt)
  if (!user) return null
  user.active = true
  delete user.deletedAt
  await writeUsers(users)
  return publicUser(user)
}

module.exports = { create, findAll, findByUsername, hashPassword, initializeAdmin, publicUser, restore, softDelete, updateProfile, updateRouting, verifyPassword }
