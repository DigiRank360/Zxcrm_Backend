const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { addCustomerEvent, findOrCreateCustomer } = require('./customerService')

const openLead = (lead) => lead.status !== 'Converted'

function normalizeValue(value) {
  return String(value || '').trim().toLowerCase()
}

function routeLead(lead, agents, leads) {
  const loads = new Map(agents.map((agent) => [
    agent.id,
    leads.filter((item) => item.agentId === agent.id && openLead(item)).length,
  ]))
  const candidates = agents.filter((agent) => {
    const load = loads.get(agent.id)
    const capacity = Number.isInteger(agent.maxOpenLeads) && agent.maxOpenLeads >= 0
      ? agent.maxOpenLeads
      : Number.MAX_SAFE_INTEGER
    if (load >= capacity) return false
    if (agent.minLeadScore !== undefined && Number(lead.score || 0) < agent.minLeadScore) return false
    if (agent.maxLeadScore !== undefined && Number(lead.score || 0) > agent.maxLeadScore) return false
    const regions = Array.isArray(agent.serviceAreas) ? agent.serviceAreas.map(normalizeValue) : []
    const location = [lead.city, lead.state].map(normalizeValue).filter(Boolean)
    if (regions.length && (!location.length || !location.some((value) => regions.includes(value)))) return false
    const propertyTypes = Array.isArray(agent.propertyTypes) ? agent.propertyTypes.map(normalizeValue) : []
    if (propertyTypes.length && (!lead.propertyType || !propertyTypes.includes(normalizeValue(lead.propertyType)))) return false
    return true
  })
  candidates.sort((a, b) => {
    const aCapacity = Number.isInteger(a.maxOpenLeads) && a.maxOpenLeads > 0 ? a.maxOpenLeads : Number.MAX_SAFE_INTEGER
    const bCapacity = Number.isInteger(b.maxOpenLeads) && b.maxOpenLeads > 0 ? b.maxOpenLeads : Number.MAX_SAFE_INTEGER
    return (loads.get(a.id) / aCapacity) - (loads.get(b.id) / bCapacity) || a.id.localeCompare(b.id)
  })
  if (!candidates.length) {
    return { agentId: null, assignmentReason: 'No active employee matched the captured routing criteria with available capacity.' }
  }
  const selected = candidates[0]
  const capacity = Number.isInteger(selected.maxOpenLeads) ? selected.maxOpenLeads : 'unlimited'
  const matched = [
    lead.city || lead.state ? `geography ${[lead.city, lead.state].filter(Boolean).join(', ')}` : '',
    lead.propertyType ? `property ${lead.propertyType}` : '',
    `score ${Number(lead.score || 0)}`,
  ].filter(Boolean).join('; ')
  return {
    agentId: selected.id,
    assignmentReason: `Matched ${matched}; lowest normalized open-lead load (${loads.get(selected.id)}/${capacity}).`,
  }
}

function normalizeLead(payload, source) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('Each lead must be a JSON object.')
    error.status = 400
    throw error
  }
  const name = payload.name || payload.full_name || payload.customer_name || payload.contact_name
  const phone = payload.phone || payload.phone_number || payload.mobile || payload.telephone
  if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || !phone.trim()) {
    const error = new Error('Each lead must contain a contact name and phone number.')
    error.status = 400
    throw error
  }
  const optionalText = ['email', 'state', 'city', 'propertyType']
  if (optionalText.some((key) => payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > 200)) ||
      ((payload.notes !== undefined || payload.message !== undefined) &&
        (typeof (payload.notes ?? payload.message) !== 'string' || (payload.notes ?? payload.message).length > 500)) ||
      (payload.score !== undefined && (!Number.isFinite(Number(payload.score)) || Number(payload.score) < 0 || Number(payload.score) > 100))) {
    const error = new Error('Lead email, geography, property type, or score is invalid.')
    error.status = 400
    throw error
  }
  return {
    id: crypto.randomUUID(),
    externalId: payload.externalId || payload.lead_id || payload.id || null,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof (payload.email || payload.email_address) === 'string' ? (payload.email || payload.email_address).trim() : '',
    notes: typeof (payload.notes || payload.message) === 'string' ? (payload.notes || payload.message).trim() : '',
    source,
    status: 'New',
    agentId: null,
    date: new Date().toISOString().slice(0, 10),
    followUp: '',
    state: typeof payload.state === 'string' ? payload.state.trim() : '',
    city: typeof payload.city === 'string' ? payload.city.trim() : '',
    propertyType: typeof payload.propertyType === 'string' ? payload.propertyType.trim() : '',
    score: Number.isFinite(Number(payload.score)) ? Math.max(0, Math.min(100, Number(payload.score))) : 0,
  }
}

async function ingest(payloads, source) {
  const inputs = (Array.isArray(payloads) ? payloads : [payloads]).map((payload) => normalizeLead(payload, source))
  if (!inputs.length) {
    const error = new Error('At least one lead is required.')
    error.status = 400
    throw error
  }
  const users = await userModel.findAll()
  const agents = users.filter((user) => user.role === 'employee' && user.active !== false)
  return crmModel.update((data) => {
    const currentLeads = data.leads
    const created = []
    for (const lead of inputs) {
      if (lead.externalId && currentLeads.some((existing) => existing.source === source && existing.externalId === lead.externalId)) continue
      if (source === 'WhatsApp' && currentLeads.some((existing) => existing.source === source && existing.phone === lead.phone)) continue
      Object.assign(lead, routeLead(lead, agents, currentLeads))
      const customer = findOrCreateCustomer(data, lead)
      lead.customerId = customer.id
      addCustomerEvent(customer, 'lead', lead.id, `Lead received from ${source}`)
      if (lead.agentId) addCustomerEvent(customer, 'lead', lead.id, `Lead assigned to ${agents.find((agent) => agent.id === lead.agentId)?.name || 'employee'}`)
      currentLeads.push(lead)
      created.push(lead)
    }
    return created
  })
}

async function createManual(payload, employee) {
  if (!employee || employee.role !== 'employee') {
    const error = new Error('Only employees can create a manual lead from the call queue.')
    error.status = 403
    throw error
  }
  const lead = normalizeLead(payload, 'Manual')
  lead.agentId = employee.id
  lead.assignmentReason = `Manually created by ${employee.name}.`
  return crmModel.update((data) => {
    const customer = findOrCreateCustomer(data, lead)
    lead.customerId = customer.id
    addCustomerEvent(customer, 'lead', lead.id, `Lead manually added by ${employee.name}`)
    addCustomerEvent(customer, 'lead', lead.id, `Lead assigned to ${employee.name}`)
    data.leads.push(lead)
    return lead
  })
}

async function autoAssign() {
  const users = await userModel.findAll()
  const agents = users.filter((user) => user.role === 'employee' && user.active !== false)
  return crmModel.update((data) => {
    const openLeads = data.leads.filter(openLead).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id).localeCompare(String(b.id)))
    for (const lead of openLeads) {
      const result = routeLead(lead, agents, data.leads.filter((item) => item.id !== lead.id))
      const changed = lead.agentId !== result.agentId
      lead.agentId = result.agentId
      lead.assignmentReason = result.assignmentReason
      if (changed) {
        const customer = (data.customers || []).find((item) => item.id === lead.customerId)
        if (customer) {
          const agent = agents.find((item) => item.id === result.agentId)
          addCustomerEvent(customer, 'lead', lead.id, agent ? `Lead routed to ${agent.name}` : 'Lead left unassigned because no employee matched capacity and routing criteria')
        }
      }
    }
    return data.leads
  })
}

module.exports = { autoAssign, createManual, ingest, routeLead }
