const crmModel = require('../models/crmModel')

function profileFor(data, customer, user) {
  const ownLeads = user.role === 'admin' ? data.leads : data.leads.filter((item) => item.agentId === user.id)
  const ownTickets = user.role === 'admin' ? data.maintenance : data.maintenance.filter((item) => item.workerId === user.id)
  const ownApplications = user.role === 'admin'
    ? data.applications.filter((item) => item.customerId === customer.id)
    : user.role === 'employee'
      ? data.applications.filter((item) => item.customerId === customer.id && item.assignedEmployeeId === user.id)
      : []
  const applicationIds = new Set(ownApplications.map((item) => item.id))
  const owns = user.role === 'admin' ||
    ownLeads.some((item) => item.customerId === customer.id) ||
    ownTickets.some((item) => item.customerId === customer.id) ||
    ownApplications.length > 0
  if (!owns) return null
  const installations = data.installations.filter((item) =>
    item.customerId === customer.id &&
    (user.role === 'admin' || (user.role === 'employee' && applicationIds.has(item.applicationId)) ||
      (user.role === 'technician' && ownTickets.some((ticket) => ticket.installationId === item.id))))
  const leads = ownLeads.filter((item) => item.customerId === customer.id)
  const applications = ownApplications
  const tickets = user.role === 'admin' || user.role === 'technician'
    ? ownTickets.filter((item) => item.customerId === customer.id)
    : []
  const visibleRecordIds = new Set([
    ...leads.map((item) => item.id),
    ...applications.map((item) => item.id),
    ...installations.map((item) => item.id),
    ...tickets.map((item) => item.id),
  ])
  return {
    ...customer,
    leads,
    applications,
    installations,
    tickets,
    history: [...(customer.history || [])].filter((event) => visibleRecordIds.has(event.recordId))
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))),
  }
}

async function list(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const profiles = (data.customers || []).map((customer) => profileFor(data, customer, req.user)).filter(Boolean)
    res.json(profiles.sort((a, b) => a.name.localeCompare(b.name)))
  } catch (error) {
    next(error)
  }
}

async function get(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const customer = (data.customers || []).find((item) => item.id === req.params.id)
    if (!customer) return res.status(404).json({ error: 'Customer not found.' })
    const profile = profileFor(data, customer, req.user)
    if (!profile) return res.status(404).json({ error: 'Customer not found.' })
    res.json(profile)
  } catch (error) {
    next(error)
  }
}

module.exports = { get, list }
