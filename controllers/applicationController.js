const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const { addCustomerEvent, findOrCreateCustomer } = require('../services/customerService')
const { approvalStages, normalizeSteps, stages } = require('../config/applicationWorkflow')

async function create(req, res, next) {
  const application = req.body
  if (!application || typeof application !== 'object' || Array.isArray(application) ||
      typeof application.customer !== 'string' || !application.customer.trim() ||
      typeof application.phone !== 'string' || !/^\+?[1-9]\d{7,14}$/.test(application.phone.trim()) ||
      typeof application.applicationNumber !== 'string' || !application.applicationNumber.trim() ||
      !Array.isArray(application.steps) || ![7, stages.length].includes(application.steps.length) ||
      application.steps.some((step, index) => !step || typeof step !== 'object' ||
        Boolean(step.completedAt) || (index > 0 && step.startedAt) ||
        (step.startedAt !== undefined && typeof step.startedAt !== 'string'))) {
    return res.status(400).json({ error: 'Provide the consumer, application number, and all workflow steps.' })
  }
  try {
    const created = {
      ...application,
      customer: application.customer.trim(),
      phone: application.phone.trim(),
      applicationNumber: application.applicationNumber.trim(),
      id: crypto.randomUUID(),
      assignedEmployeeId: req.user.id,
      assignedEmployeeName: req.user.name,
      installationId: null,
      createdAt: new Date().toISOString(),
      approvalHistory: [],
      steps: normalizeSteps(application.steps).map((step, index) => ({
        ...step,
        startedAt: index === 0 ? new Date().toISOString() : '',
        completedAt: '',
        approvalStatus: approvalStages.includes(index) ? 'Pending' : 'Not required',
      })),
    }
    await crmModel.update((data) => {
      if (data.applications.some((item) => item.applicationNumber === created.applicationNumber)) {
        const error = new Error('This application number already exists.')
        error.status = 409
        throw error
      }
      const customer = findOrCreateCustomer(data, {
        name: created.customer, phone: created.phone, email: created.email,
        address: created.address, state: created.state, city: created.city,
      })
      created.customerId = customer.id
      addCustomerEvent(customer, 'application', created.id, `Solar application ${created.applicationNumber} created`)
      data.applications.unshift(created)
    })
    res.status(201).json(created)
  } catch (error) {
    next(error)
  }
}

async function completeStep(req, res, next) {
  try {
    const application = await crmModel.update((data) => {
      const found = data.applications.find((item) => item.id === req.params.id)
      if (!found) {
        const error = new Error('Solar application not found.')
        error.status = 404
        throw error
      }
      if (req.user.role !== 'admin' && found.assignedEmployeeId !== req.user.id) {
        const error = new Error('You can only advance applications assigned to you.')
        error.status = 403
        throw error
      }
      if (req.user.role === 'admin') {
        const error = new Error('Administrators can review and approve applications but cannot complete employee workflow steps.')
        error.status = 403
        throw error
      }
      const stage = found.steps.findIndex((step) => !step.completedAt)
      if (stage < 0) {
        const error = new Error('All workflow steps are already completed.')
        error.status = 409
        throw error
      }
      if (approvalStages.includes(stage) && found.steps[stage].approvalStatus !== 'Approved') {
        const error = new Error('This workflow stage requires approval before it can be completed.')
        error.status = 409
        throw error
      }
      const now = new Date().toISOString()
      found.steps[stage].completedAt = now
      if (found.steps[stage + 1]) found.steps[stage + 1].startedAt = now
      let commissionedInstallation
      let commissionedTickets
      if (stage === 9 && !found.installationId) {
        const customer = findOrCreateCustomer(data, {
          name: found.customer,
          phone: found.phone,
          email: found.email || '',
          address: [found.village, found.city, found.state, found.pinCode].filter(Boolean).join(', '),
          state: found.state || '',
          city: found.city || '',
        })
        const installDate = now.slice(0, 10)
        const installationId = crypto.randomUUID()
        const installation = {
          id: installationId,
          applicationId: found.id,
          applicationNumber: found.applicationNumber,
          customerId: customer.id,
          customer: found.customer,
          phone: found.phone,
          email: found.email || '',
          address: [found.village, found.city, found.state, found.pinCode].filter(Boolean).join(', '),
          state: found.state || '',
          city: found.city || '',
          propertyType: found.propertyType || '',
          discom: found.discom || '',
          approvedCapacity: found.approvedCapacity || '',
          installedCapacity: found.installedCapacity || '',
          subsidyAmount: found.subsidyAmount || '',
          installDate,
          status: 'Active',
        }
        const tickets = Array.from({ length: 4 }, (_, index) => {
          const dueDate = new Date(`${installDate}T00:00:00.000Z`)
          dueDate.setUTCMonth(dueDate.getUTCMonth() + (index + 1) * 3)
          return {
            id: crypto.randomUUID(),
            customerId: customer.id,
            installationId,
            applicationId: found.id,
            title: 'Quarterly maintenance',
            description: 'Scheduled preventive maintenance visit after successful commissioning.',
            type: 'AMC',
            dueDate: dueDate.toISOString().slice(0, 10),
            workerId: null,
            status: 'Pending',
          }
        })
        data.installations.push(installation)
        data.maintenance.push(...tickets)
        found.installationId = installationId
        commissionedInstallation = installation
        commissionedTickets = tickets
        addCustomerEvent(customer, 'installation', installationId, `Solar installation commissioned on ${installDate}`)
      }
      return { application: found, commissionedInstallation, commissionedTickets }
    })
    res.json({
      ...application.application,
      ...(application.commissionedInstallation ? {
        commissionedInstallation: application.commissionedInstallation,
        commissionedTickets: application.commissionedTickets,
      } : {}),
    })
  } catch (error) {
    next(error)
  }
}

async function decideApproval(req, res, next) {
  const { decision, note = '' } = req.body || {}
  if (!['Approved', 'Rejected'].includes(decision) || typeof note !== 'string' || note.length > 1000 ||
      (decision === 'Rejected' && !note.trim())) {
    return res.status(400).json({ error: 'Provide an Approved or Rejected decision and a note up to 1000 characters.' })
  }
  try {
    const application = await crmModel.update((data) => {
      const found = data.applications.find((item) => item.id === req.params.id)
      if (!found) {
        const error = new Error('Solar application not found.')
        error.status = 404
        throw error
      }
      if (req.user.role !== 'admin') {
        const error = new Error('Only administrators can approve or reject application stages.')
        error.status = 403
        throw error
      }
      const stage = found.steps.findIndex((step) => !step.completedAt)
      if (!approvalStages.includes(stage)) {
        const error = new Error('Approval is only available at Feasibility and Post-site Inspection.')
        error.status = 409
        throw error
      }
      const now = new Date().toISOString()
      found.steps[stage].approvalStatus = decision
      found.approvalHistory ||= []
      found.approvalHistory.push({ stage, decision, note: note.trim(), userId: req.user.id, occurredAt: now })
      return found
    })
    res.json(application)
  } catch (error) {
    next(error)
  }
}

module.exports = { completeStep, create, decideApproval }
