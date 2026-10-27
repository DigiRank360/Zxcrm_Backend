const userModel = require('../models/userModel')
const { isValidUsername } = require('../utils/username')
const authService = require('../services/authService')

async function list(req, res, next) {
  try {
    res.json(await userModel.findAll({ includeInactive: true }))
  } catch (error) {
    next(error)
  }
}

async function create(req, res, next) {
  const { name, username, password, role, phone, maxOpenLeads, serviceAreas = [], propertyTypes = [], minLeadScore, maxLeadScore } = req.body || {}
  const validStrings = (items) => Array.isArray(items) && items.length <= 100 && items.every((item) => typeof item === 'string' && item.trim().length <= 100)
  const validBound = (value) => value === undefined || (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100)
  if (typeof name !== 'string' || !name.trim() ||
      !isValidUsername(username) ||
      typeof password !== 'string' || password.length < 12 ||
      !['employee', 'technician', 'hr'].includes(role) ||
      (phone !== undefined && typeof phone !== 'string') ||
      (maxOpenLeads !== undefined && (!Number.isInteger(Number(maxOpenLeads)) || Number(maxOpenLeads) < 0 || Number(maxOpenLeads) > 10000)) ||
      !validStrings(serviceAreas) || !validStrings(propertyTypes) ||
      !validBound(minLeadScore) || !validBound(maxLeadScore) ||
      (minLeadScore !== undefined && maxLeadScore !== undefined && Number(minLeadScore) > Number(maxLeadScore))) {
    return res.status(400).json({
      error: 'Provide a name, a 3–40 character login ID (email-style IDs are supported), a password of at least 12 characters, and role employee, technician, or hr.',
    })
  }
  try {
    res.status(201).json(await userModel.create({ name, username, password, role, phone, maxOpenLeads, serviceAreas, propertyTypes, minLeadScore, maxLeadScore }))
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message })
    next(error)
  }
}

async function updateRouting(req, res, next) {
  const { active, maxOpenLeads, serviceAreas, propertyTypes, minLeadScore, maxLeadScore } = req.body || {}
  const validStrings = (items) => Array.isArray(items) && items.length <= 100 && items.every((item) => typeof item === 'string' && item.trim().length <= 100)
  const validBound = (value) => value === undefined || (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100)
  if ((active !== undefined && typeof active !== 'boolean') ||
      (maxOpenLeads !== undefined && (!Number.isInteger(Number(maxOpenLeads)) || Number(maxOpenLeads) < 0 || Number(maxOpenLeads) > 10000)) ||
      (serviceAreas !== undefined && !validStrings(serviceAreas)) ||
      (propertyTypes !== undefined && !validStrings(propertyTypes)) ||
      !validBound(minLeadScore) || !validBound(maxLeadScore) ||
      (minLeadScore !== undefined && maxLeadScore !== undefined && Number(minLeadScore) > Number(maxLeadScore))) {
    return res.status(400).json({ error: 'Provide valid active status and routing criteria.' })
  }
  try {
    const updated = await userModel.updateRouting(req.params.id, {
      ...(active !== undefined ? { active } : {}),
      ...(maxOpenLeads !== undefined ? { maxOpenLeads: Number(maxOpenLeads) } : {}),
      ...(serviceAreas !== undefined ? { serviceAreas: serviceAreas.map((item) => item.trim()) } : {}),
      ...(propertyTypes !== undefined ? { propertyTypes: propertyTypes.map((item) => item.trim()) } : {}),
      ...(minLeadScore !== undefined ? { minLeadScore: Number(minLeadScore) } : {}),
      ...(maxLeadScore !== undefined ? { maxLeadScore: Number(maxLeadScore) } : {}),
    })
    if (!updated) return res.status(404).json({ error: 'Employee not found.' })
    if (active === false) authService.revokeUserSessions(updated.id)
    res.json(updated)
  } catch (error) {
    next(error)
  }
}

async function update(req, res, next) {
  const { name, username, phone, password, maxOpenLeads, serviceAreas, propertyTypes, minLeadScore, maxLeadScore } = req.body || {}
  const validStrings = (items) => Array.isArray(items) && items.length <= 100 && items.every((item) => typeof item === 'string' && item.trim().length <= 100)
  const validLimit = (value, max) => value === undefined || value === null || (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= max)
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      !isValidUsername(username) ||
      (phone !== undefined && (typeof phone !== 'string' || phone.length > 50)) ||
      (password !== undefined && (typeof password !== 'string' || password.length < 12 || password.length > 200)) ||
      !validLimit(maxOpenLeads, 10000) ||
      (serviceAreas !== undefined && !validStrings(serviceAreas)) ||
      (propertyTypes !== undefined && !validStrings(propertyTypes)) ||
      !validLimit(minLeadScore, 100) || !validLimit(maxLeadScore, 100) ||
      (minLeadScore != null && maxLeadScore != null && Number(minLeadScore) > Number(maxLeadScore))) {
    return res.status(400).json({ error: 'Provide a valid name, login ID, phone, password, and routing criteria.' })
  }
  const updates = {
    name: name.trim(),
    username: username.trim().toLowerCase(),
    phone: (phone || '').trim(),
  }
  if (password) updates.password = password
  if (maxOpenLeads !== undefined) updates.maxOpenLeads = maxOpenLeads === null ? undefined : Number(maxOpenLeads)
  if (serviceAreas !== undefined) updates.serviceAreas = serviceAreas.map((item) => item.trim())
  if (propertyTypes !== undefined) updates.propertyTypes = propertyTypes.map((item) => item.trim())
  if (minLeadScore !== undefined) updates.minLeadScore = minLeadScore === null ? undefined : Number(minLeadScore)
  if (maxLeadScore !== undefined) updates.maxLeadScore = maxLeadScore === null ? undefined : Number(maxLeadScore)

  try {
    const updated = await userModel.updateProfile(req.params.id, updates)
    if (!updated) return res.status(404).json({ error: 'Active employee, technician, or HR account not found.' })
    if (password) authService.revokeUserSessions(updated.id)
    res.json(updated)
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That user ID is already in use.' })
    next(error)
  }
}

async function softDelete(req, res, next) {
  try {
    const deleted = await userModel.softDelete(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Active employee, technician, or HR account not found.' })
    authService.revokeUserSessions(deleted.id)
    res.json(deleted)
  } catch (error) {
    next(error)
  }
}

async function restore(req, res, next) {
  try {
    const restored = await userModel.restore(req.params.id)
    if (!restored) return res.status(404).json({ error: 'Deleted employee, technician, or HR account not found.' })
    res.json(restored)
  } catch (error) {
    next(error)
  }
}

module.exports = { create, list, restore, softDelete, update, updateRouting }
