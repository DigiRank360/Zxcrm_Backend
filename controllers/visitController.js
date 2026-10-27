const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')

async function list(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const visits = data.visits || []
    res.json(['admin', 'hr'].includes(req.user.role) ? visits : visits.filter((visit) => visit.userId === req.user.id))
  } catch (error) {
    next(error)
  }
}

async function create(req, res, next) {
  const { kind, customer, note = '', photoUrl } = req.body || {}
  if (!['Site visit', 'Sales visit'].includes(kind) ||
      typeof customer !== 'string' || !customer.trim() || customer.trim().length > 150 ||
      typeof note !== 'string' || note.length > 2000 ||
      typeof photoUrl !== 'string' || !/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(photoUrl)) {
    return res.status(400).json({ error: 'Provide a visit type, customer/site, note, and uploaded Cloudinary photo.' })
  }
  try {
    const visit = await crmModel.update((data) => {
      data.visits ||= []
      const created = {
        id: crypto.randomUUID(),
        userId: req.user.id,
        employee: req.user.name,
        kind,
        customer: customer.trim(),
        note: note.trim(),
        photoUrl,
        visitedAt: new Date().toISOString(),
      }
      data.visits.unshift(created)
      return created
    })
    res.status(201).json(visit)
  } catch (error) {
    next(error)
  }
}

module.exports = { create, list }
