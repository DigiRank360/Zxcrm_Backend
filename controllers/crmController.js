const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { addCustomerEvent } = require('../services/customerService')

const leadStatuses = new Set(['New', 'Interested', 'Busy', 'Not Picked', 'Not Interested', 'Converted'])

const permissions = {
  leads: ['admin', 'employee'],
  attendance: ['admin', 'employee', 'technician'],
  installations: ['admin'],
  maintenance: ['admin'],
  applications: ['admin'],
}

async function getCrm(req, res, next) {
  try {
    const [data, users] = await Promise.all([
      crmModel.findAll(),
      userModel.findAll({ includeInactive: req.user.role === 'admin' }),
    ])
    data.users = req.user.role === 'admin' ? users
      : req.user.role === 'employee' ? users.filter((user) => user.id === req.user.id || (user.role === 'technician' && user.active !== false))
        : users.filter((user) => user.id === req.user.id)
    if (req.user.role === 'employee') data.leads = data.leads.filter((lead) => lead.agentId === req.user.id)
    if (['technician', 'hr'].includes(req.user.role)) data.leads = []
    if (req.user.role === 'employee') data.applications = data.applications.filter((application) => application.assignedEmployeeId === req.user.id)
    if (!['admin', 'employee'].includes(req.user.role)) data.applications = []
    if (req.user.role === 'technician') {
      data.maintenance = data.maintenance.filter((job) => job.workerId === req.user.id)
      const installationIds = new Set(data.maintenance.map((job) => job.installationId))
      data.installations = data.installations.filter((installation) => installationIds.has(installation.id))
      const customerIds = new Set(data.maintenance.map((job) => job.customerId).filter(Boolean))
      data.customers = (data.customers || []).filter((customer) => customerIds.has(customer.id))
    } else if (req.user.role === 'employee') {
      const applicationIds = new Set(data.applications.map((application) => application.id))
      const installations = data.installations.filter((installation) => applicationIds.has(installation.applicationId))
      data.installations = installations
      const installationIds = new Set(installations.map((installation) => installation.id))
      data.maintenance = data.maintenance.filter((job) => installationIds.has(job.installationId))
      const customerIds = new Set([
        ...data.leads.map((lead) => lead.customerId).filter(Boolean),
        ...installations.map((installation) => installation.customerId).filter(Boolean),
      ])
      data.customers = (data.customers || []).filter((customer) => customerIds.has(customer.id))
    } else if (req.user.role === 'hr') {
      data.installations = []
      data.maintenance = []
      data.customers = []
    } else {
      data.customers ||= []
    }
    data.visits ||= []
    if (req.user.role === 'employee') data.visits = data.visits.filter((visit) => visit.userId === req.user.id)
    if (req.user.role === 'technician') data.visits = []
    data.hrProfiles = []
    data.payroll = []
    if (!['admin', 'hr'].includes(req.user.role)) {
      data.attendance = data.attendance.filter((row) => row.userId ? row.userId === req.user.id : row.employee === req.user.name)
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
}

async function updateResource(req, res, next) {
  const { resource } = req.params
  const allowedRoles = permissions[resource]
  if (!allowedRoles) return res.status(404).json({ error: 'CRM resource not found.' })
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have permission to update this data.' })
  }
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'CRM resource data must be an array.' })

  try {
    const submitted = req.body
    if (['installations', 'maintenance', 'applications'].includes(resource)) {
      return res.status(409).json({ error: 'Use the dedicated resource workflow API instead of replacing lifecycle records.' })
    }
    if (resource === 'leads' &&
        (submitted.some((lead) => !lead || typeof lead.id !== 'string' ||
          !leadStatuses.has(lead.status) || (lead.followUp !== undefined && typeof lead.followUp !== 'string')) ||
          new Set(submitted.map((lead) => lead.id)).size !== submitted.length)) {
      return res.status(400).json({ error: 'Lead updates must have unique IDs, valid statuses, and text follow-up values.' })
    }
    const updated = await crmModel.update((data) => {
      if (resource === 'leads' && req.user.role === 'employee') {
        const assigned = new Set(data.leads.filter((lead) => lead.agentId === req.user.id).map((lead) => lead.id))
        if (submitted.some((lead) => !assigned.has(lead.id)) || new Set(submitted.map((lead) => lead.id)).size !== assigned.size) {
          const error = new Error('Employees can only update their assigned leads.')
          error.status = 403
          throw error
        }
        const updates = new Map(submitted.map((lead) => [lead.id, lead]))
        data.leads = data.leads.map((lead) => {
          const update = updates.get(lead.id)
          if (update && update.status !== lead.status) {
            const customer = (data.customers || []).find((item) => item.id === lead.customerId)
            if (customer) addCustomerEvent(customer, 'lead', lead.id, `Lead status changed to ${update.status}`)
          }
          return update ? { ...lead, status: update.status, followUp: update.followUp } : lead
        })
      } else if (resource === 'leads' && req.user.role === 'admin') {
        const existingIds = new Set(data.leads.map((lead) => lead.id))
        if (submitted.length !== existingIds.size || submitted.some((lead) => !existingIds.has(lead.id))) {
          const error = new Error('Create leads through the import or intake API; existing lead records cannot be removed.')
          error.status = 409
          throw error
        }
        const updates = new Map(submitted.map((lead) => [lead.id, lead]))
        data.leads = data.leads.map((lead) => {
          const update = updates.get(lead.id)
          if (update.agentId !== lead.agentId || update.customerId !== lead.customerId || update.name !== lead.name || update.phone !== lead.phone) {
            const error = new Error('Use the routing API to assign leads; profile data is immutable through bulk updates.')
            error.status = 409
            throw error
          }
          if (update.status !== lead.status) {
            const customer = (data.customers || []).find((item) => item.id === lead.customerId)
            if (customer) addCustomerEvent(customer, 'lead', lead.id, `Lead status changed to ${update.status}`)
          }
          return { ...lead, status: update.status, followUp: update.followUp }
        })
      } else if (resource === 'attendance' && req.user.role !== 'admin') {
        const ownsRow = (row) => row.userId === req.user.id || row.employee === req.user.name
        const existing = data.attendance.filter((row) => !ownsRow(row))
        data.attendance = [...existing, ...submitted.filter(ownsRow)]
      } else {
        data[resource] = submitted
      }
      return data[resource]
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
}

module.exports = { getCrm, updateResource }
