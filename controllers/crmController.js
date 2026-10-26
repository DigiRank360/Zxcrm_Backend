const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')

const permissions = {
  leads: ['admin', 'employee'],
  attendance: ['admin', 'employee', 'technician'],
  installations: ['admin'],
  maintenance: ['admin'],
  applications: ['admin'],
}

async function getCrm(req, res, next) {
  try {
    const [data, users] = await Promise.all([crmModel.findAll(), userModel.findAll()])
    data.users = req.user.role === 'admin' ? users : users.filter((user) => user.id === req.user.id)
    if (req.user.role === 'employee') data.leads = data.leads.filter((lead) => lead.agentId === req.user.id)
    if (req.user.role === 'technician') data.leads = []
    if (req.user.role !== 'admin') data.applications = []
    if (req.user.role === 'technician') {
      data.maintenance = data.maintenance.filter((job) => job.workerId === req.user.id)
      const installationIds = new Set(data.maintenance.map((job) => job.installationId))
      data.installations = data.installations.filter((installation) => installationIds.has(installation.id))
    } else if (req.user.role === 'employee') {
      data.maintenance = []
      data.installations = []
    }
    if (req.user.role !== 'admin') {
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
          return update ? { ...lead, status: update.status, followUp: update.followUp } : lead
        })
      } else if (resource === 'leads' && req.user.role === 'admin') {
        const existingIds = new Set(data.leads.map((lead) => lead.id))
        const updates = new Map(submitted.map((lead) => [lead.id, lead]))
        data.leads = [
          ...data.leads.map((lead) => updates.get(lead.id) || lead),
          ...submitted.filter((lead) => !existingIds.has(lead.id)),
        ]
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
