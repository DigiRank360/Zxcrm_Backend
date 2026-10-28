const crypto = require('node:crypto')
const leadService = require('../services/leadService')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { addCustomerEvent } = require('../services/customerService')

const editableFields = ['name', 'phone', 'email', 'state', 'city', 'propertyType', 'score', 'notes', 'status', 'followUp']
const statuses = new Set(['New', 'Interested', 'Busy', 'Not Picked', 'Not Interested', 'Converted'])

async function autoAssign(req, res, next) {
  try {
    res.json(await leadService.autoAssign())
  } catch (error) {
    next(error)
  }
}

async function importLeads(req, res, next) {
  try {
    if (!Array.isArray(req.body) || req.body.length < 1 || req.body.length > 500) {
      return res.status(400).json({ error: 'Import between 1 and 500 leads at a time.' })
    }
    const leads = await leadService.ingest(req.body, 'CSV')
    res.status(201).json({ created: leads.length, leads })
  } catch (error) {
    next(error)
  }
}

async function assign(req, res, next) {
  const { agentId } = req.body || {}
  if (agentId !== null && typeof agentId !== 'string') return res.status(400).json({ error: 'Provide an employee ID or null to unassign.' })
  try {
    const users = await userModel.findAll()
    const agents = users.filter((user) => user.role === 'employee')
    const updated = await crmModel.update((data) => {
      const lead = data.leads.find((item) => item.id === req.params.id)
      if (!lead) {
        const error = new Error('Lead not found.')
        error.status = 404
        throw error
      }
      if (agentId === null) {
        const wasAssigned = lead.agentId
        lead.agentId = null
        lead.assignmentReason = 'Manually unassigned by administrator.'
        if (wasAssigned) {
          const customer = (data.customers || []).find((item) => item.id === lead.customerId)
          if (customer) addCustomerEvent(customer, 'lead', lead.id, 'Lead manually unassigned')
        }
        return lead
      }
      const agent = agents.find((item) => item.id === agentId)
      if (!agent) {
        const error = new Error('Select an active employee.')
        error.status = 400
        throw error
      }
      if (lead.agentId === agent.id) return lead
      const result = leadService.routeLead(lead, [agent], data.leads.filter((item) => item.id !== lead.id))
      if (!result.agentId) {
        const error = new Error(`Employee is not eligible: ${result.assignmentReason}`)
        error.status = 409
        throw error
      }
      const changed = lead.agentId !== agent.id
      lead.agentId = agent.id
      lead.assignmentReason = `Manually assigned; ${result.assignmentReason}`
      if (changed) {
        const customer = (data.customers || []).find((item) => item.id === lead.customerId)
        if (customer) addCustomerEvent(customer, 'lead', lead.id, `Lead manually assigned to ${agent.name}`)
      }
      return lead
    })
    res.json({ lead: updated })
  } catch (error) {
    next(error)
  }
}

async function transferLocation(req, res, next) {
  const { state, city, note = '' } = req.body || {}
  const valid = (value) => typeof value === 'string' && value.trim() && value.trim().length <= 100
  if (!valid(state) || !valid(city) || typeof note !== 'string' || note.length > 300) {
    return res.status(400).json({ error: 'Choose the destination state and city (note up to 300 characters).' })
  }
  const toState = state.trim()
  const toCity = city.trim()
  try {
    const updated = await crmModel.update((data) => {
      const lead = data.leads.find((item) => item.id === req.params.id)
      if (!lead) {
        const error = new Error('Lead not found.')
        error.status = 404
        throw error
      }
      if (req.user.role === 'employee' && lead.agentId !== req.user.id) {
        const error = new Error('Employees can only transfer their assigned leads.')
        error.status = 403
        throw error
      }
      if ((lead.state || '') === toState && (lead.city || '') === toCity) {
        const error = new Error('The lead is already in this location.')
        error.status = 400
        throw error
      }
      const from = [lead.city, lead.state].filter(Boolean).join(', ') || 'Unassigned location'
      const to = `${toCity}, ${toState}`
      lead.transfers ||= []
      lead.transfers.unshift({
        id: crypto.randomUUID(),
        fromState: lead.state || '',
        fromCity: lead.city || '',
        toState,
        toCity,
        note: note.trim(),
        transferredBy: req.user.name,
        transferredAt: new Date().toISOString(),
      })
      lead.state = toState
      lead.city = toCity
      const customer = (data.customers || []).find((item) => item.id === lead.customerId)
      if (customer) addCustomerEvent(customer, 'lead', lead.id, `Lead transferred from ${from} to ${to} by ${req.user.name}`)
      return lead
    })
    res.json({ lead: updated })
  } catch (error) {
    next(error)
  }
}

async function update(req, res, next) {
  const updates = req.body || {}
  if (!updates || typeof updates !== 'object' || Array.isArray(updates) ||
      Object.keys(updates).some((key) => !editableFields.includes(key))) {
    return res.status(400).json({ error: 'Only lead profile, status, notes, and follow-up fields can be edited.' })
  }
  if (updates.status !== undefined && !statuses.has(updates.status)) {
    return res.status(400).json({ error: 'Choose a valid lead status.' })
  }
  if (updates.name !== undefined && (typeof updates.name !== 'string' || !updates.name.trim() || updates.name.length > 150)) {
    return res.status(400).json({ error: 'Lead name is required and must be 150 characters or fewer.' })
  }
  if (updates.phone !== undefined && (typeof updates.phone !== 'string' || !/^\+?[1-9]\d{7,14}$/.test(updates.phone.trim()))) {
    return res.status(400).json({ error: 'Provide a valid lead phone number.' })
  }
  if (updates.score !== undefined && (!Number.isInteger(Number(updates.score)) || Number(updates.score) < 0 || Number(updates.score) > 100)) {
    return res.status(400).json({ error: 'Lead score must be an integer from 0 to 100.' })
  }
  if (['email', 'state', 'city', 'propertyType', 'notes', 'followUp'].some((key) =>
    updates[key] !== undefined && (typeof updates[key] !== 'string' || updates[key].length > 500))) {
    return res.status(400).json({ error: 'Lead text fields must be valid strings of 500 characters or fewer.' })
  }
  try {
    const updated = await crmModel.update((data) => {
      const lead = data.leads.find((item) => item.id === req.params.id)
      if (!lead) {
        const error = new Error('Lead not found.')
        error.status = 404
        throw error
      }
      if (req.user.role === 'employee' && lead.agentId !== req.user.id) {
        const error = new Error('Employees can only edit their assigned leads.')
        error.status = 403
        throw error
      }
      const beforeStatus = lead.status
      for (const key of editableFields) {
        if (updates[key] !== undefined) lead[key] = key === 'name' || key === 'phone' ? updates[key].trim() : updates[key]
      }
      if (updates.score !== undefined) lead.score = Number(updates.score)
      if (beforeStatus !== lead.status) {
        const customer = (data.customers || []).find((item) => item.id === lead.customerId)
        if (customer) addCustomerEvent(customer, 'lead', lead.id, `Lead status changed to ${lead.status}`)
      }
      return lead
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
}

module.exports = { assign, autoAssign, importLeads, transferLocation, update }
