const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')

const byDate = (a, b) => a.date.localeCompare(b.date)

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function list(req, res, next) {
  try {
    const data = await crmModel.findAll()
    res.json((data.holidays || []).slice().sort(byDate))
  } catch (error) {
    next(error)
  }
}

async function create(req, res, next) {
  const { date, name, description = '' } = req.body || {}
  if (!validDate(date) || typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      typeof description !== 'string' || description.length > 300) {
    return res.status(400).json({ error: 'Provide a valid date (YYYY-MM-DD) and a holiday name.' })
  }
  try {
    const holiday = await crmModel.update((data) => {
      data.holidays ||= []
      if (data.holidays.some((item) => item.date === date)) {
        const error = new Error('A holiday is already defined for this date.')
        error.status = 409
        throw error
      }
      const created = {
        id: crypto.randomUUID(),
        date,
        name: name.trim(),
        description: description.trim(),
        createdBy: req.user.name,
      }
      data.holidays.push(created)
      return created
    })
    res.status(201).json(holiday)
  } catch (error) {
    next(error)
  }
}

async function remove(req, res, next) {
  try {
    await crmModel.update((data) => {
      data.holidays ||= []
      const index = data.holidays.findIndex((item) => item.id === req.params.id)
      if (index === -1) {
        const error = new Error('Holiday not found.')
        error.status = 404
        throw error
      }
      data.holidays.splice(index, 1)
    })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
}

module.exports = { create, list, remove }
