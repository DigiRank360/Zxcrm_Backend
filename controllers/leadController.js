const leadService = require('../services/leadService')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { addCustomerEvent } = require('../services/customerService')

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

module.exports = { assign, autoAssign, importLeads }
