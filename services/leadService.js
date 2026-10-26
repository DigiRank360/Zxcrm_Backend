const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')

function normalizeLead(payload, source) {
  const name = payload.name || payload.full_name || payload.customer_name || payload.contact_name
  const phone = payload.phone || payload.phone_number || payload.mobile || payload.telephone
  if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || !phone.trim()) {
    const error = new Error('Each lead must contain a contact name and phone number.')
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
    const lastAssigned = [...currentLeads].reverse().find((lead) => lead.agentId)
    let nextAgentIndex = lastAssigned ? agents.findIndex((agent) => agent.id === lastAssigned.agentId) + 1 : 0
    const created = []
    for (const lead of inputs) {
      if (lead.externalId && currentLeads.some((existing) => existing.source === source && existing.externalId === lead.externalId)) continue
      if (source === 'WhatsApp' && currentLeads.some((existing) => existing.source === source && existing.phone === lead.phone)) continue
      if (agents.length) {
        lead.agentId = agents[nextAgentIndex % agents.length].id
        nextAgentIndex += 1
      }
      currentLeads.push(lead)
      created.push(lead)
    }
    return created
  })
}

async function autoAssign() {
  const users = await userModel.findAll()
  const agents = users.filter((user) => user.role === 'employee')
  if (!agents.length) return crmModel.findAll().then((data) => data.leads)
  return crmModel.update((data) => {
    const load = new Map(agents.map((agent) => [agent.id, 0]))
    const openLeads = data.leads.filter((lead) => lead.status !== 'Converted')
    for (const lead of openLeads) {
      const agent = agents.reduce((lowest, current) => load.get(current.id) < load.get(lowest.id) ? current : lowest)
      lead.agentId = agent.id
      load.set(agent.id, load.get(agent.id) + 1)
    }
    return data.leads
  })
}

module.exports = { autoAssign, ingest }
