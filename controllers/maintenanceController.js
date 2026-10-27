const crmModel = require('../models/crmModel')
const otpService = require('../services/otpService')
const userModel = require('../models/userModel')
const { addCustomerEvent } = require('../services/customerService')
const crypto = require('node:crypto')

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function create(req, res, next) {
  const { customerId, installationId, title, description = '', priority = 'Normal', dueDate, workerId = null } = req.body || {}
  if (typeof customerId !== 'string' || !customerId ||
      typeof installationId !== 'string' || !installationId ||
      typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
      typeof description !== 'string' || description.length > 2000 ||
      !['Low', 'Normal', 'High', 'Urgent'].includes(priority) ||
      !validDate(dueDate) ||
      (workerId !== null && typeof workerId !== 'string')) {
    return res.status(400).json({ error: 'Provide a customer, an installation, title, valid due date, priority, and optional active technician.' })
  }
  try {
    const users = await userModel.findAll()
    if (workerId && !users.some((user) => user.id === workerId && user.role === 'technician')) {
      return res.status(400).json({ error: 'Select an active technician.' })
    }
    const ticket = await crmModel.update((data) => {
      const customer = (data.customers || []).find((item) => item.id === customerId)
      const installation = data.installations.find((item) => item.id === installationId)
      if (!customer || !installation || installation.customerId !== customerId) {
        const error = new Error('Customer or installation not found.')
        error.status = 404
        throw error
      }
      const created = {
        id: crypto.randomUUID(),
        customerId,
        installationId,
        title: title.trim(),
        description: description.trim(),
        priority,
        dueDate,
        workerId,
        type: 'Service',
        status: 'Pending',
        createdAt: new Date().toISOString(),
      }
      data.maintenance.push(created)
      addCustomerEvent(customer, 'ticket', created.id, `Service ticket created${workerId ? ' and assigned' : ''}: ${created.title}`)
      return created
    })
    res.status(201).json({ ticket })
  } catch (error) {
    next(error)
  }
}

async function assign(req, res, next) {
  const input = req.body || {}
  const { workerId, priority, title, description, dueDate } = input
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['workerId', 'priority', 'title', 'description', 'dueDate'].some((key) => input[key] !== undefined)) {
    return res.status(400).json({ error: 'Provide at least one valid ticket assignment or detail field.' })
  }
  if ((workerId !== undefined && workerId !== null && typeof workerId !== 'string') ||
      (priority !== undefined && !['Low', 'Normal', 'High', 'Urgent'].includes(priority)) ||
      (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 120)) ||
      (description !== undefined && (typeof description !== 'string' || description.length > 2000)) ||
      (dueDate !== undefined && !validDate(dueDate))) {
    return res.status(400).json({ error: 'Provide valid ticket assignment and details.' })
  }
  try {
    const users = await userModel.findAll()
    if (workerId && !users.some((user) => user.id === workerId && user.role === 'technician')) {
      return res.status(400).json({ error: 'Select an active technician.' })
    }
    const ticket = await crmModel.update((data) => {
      const found = data.maintenance.find((item) => item.id === req.params.id)
      if (!found) {
        const error = new Error('Service ticket not found.')
        error.status = 404
        throw error
      }
      if (found.status === 'Completed') {
        const error = new Error('Completed tickets cannot be reassigned or edited.')
        error.status = 409
        throw error
      }
      const original = JSON.stringify({
        workerId: found.workerId, priority: found.priority, title: found.title,
        description: found.description, dueDate: found.dueDate,
      })
      const previousWorkerId = found.workerId
      for (const key of ['workerId', 'priority', 'title', 'description', 'dueDate']) {
        if (input[key] !== undefined) found[key] = key === 'title' || key === 'description' ? input[key].trim() : input[key]
      }
      const updated = JSON.stringify({
        workerId: found.workerId, priority: found.priority, title: found.title,
        description: found.description, dueDate: found.dueDate,
      })
      if (original !== updated) {
        const customer = (data.customers || []).find((item) => item.id === found.customerId)
        const assigned = users.find((user) => user.id === found.workerId)
        const summary = previousWorkerId !== found.workerId
          ? (assigned ? `Service ticket assigned to ${assigned.name}` : 'Service ticket unassigned')
          : `Service ticket updated: ${found.title || 'Service job'}`
        if (customer) addCustomerEvent(customer, 'ticket', found.id, summary)
      }
      return found
    })
    res.json({ ticket })
  } catch (error) {
    next(error)
  }
}

async function requestOtp(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const job = data.maintenance.find((item) => String(item.id) === req.params.id)
    if (!job) return res.status(404).json({ error: 'Service job not found.' })
    if (job.workerId !== req.user.id) return res.status(403).json({ error: 'This service job is assigned to another technician.' })
    if (job.status === 'Completed') return res.status(409).json({ error: 'This service job is already completed.' })
    const installation = data.installations.find((item) => item.id === job.installationId)
    const customer = (data.customers || []).find((item) => item.id === job.customerId)
    const result = await otpService.issue(job.id, customer?.phone || installation?.phone)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

async function verifyOtp(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const existing = data.maintenance.find((item) => String(item.id) === req.params.id)
    if (!existing) return res.status(404).json({ error: 'Service job not found.' })
    if (existing.workerId !== req.user.id) return res.status(403).json({ error: 'This service job is assigned to another technician.' })
    if (existing.status === 'Completed') return res.status(409).json({ error: 'This service job is already completed.' })
    const result = otpService.verify(req.params.id, req.body?.otp)
    if (!result.valid) return res.status(result.status).json({ error: result.error })
    const job = await crmModel.update((data) => {
      const found = data.maintenance.find((item) => String(item.id) === req.params.id)
      if (!found) {
        const error = new Error('Service job not found.')
        error.status = 404
        throw error
      }
      if (found.workerId !== req.user.id) {
        const error = new Error('This service job is assigned to another technician.')
        error.status = 403
        throw error
      }
      if (found.status === 'Completed') {
        const error = new Error('This service job is already completed.')
        error.status = 409
        throw error
      }
      found.status = 'Completed'
      const customer = (data.customers || []).find((item) => item.id === found.customerId)
      if (customer) addCustomerEvent(customer, 'ticket', found.id, `Service completed: ${found.title || 'Service job'}`)
      return found
    })
    res.json({ job })
  } catch (error) {
    next(error)
  }
}

module.exports = { assign, create, requestOtp, verifyOtp }
