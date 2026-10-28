const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const { addCustomerEvent, findOrCreateCustomer } = require('../services/customerService')
const { privateDownloadUrl, uploadPrivateFile } = require('../services/privateDocumentService')
const { approvalStages, normalizeSteps, stages } = require('../config/applicationWorkflow')

const amountFields = ['totalPlantCost', 'subsidyAmount', 'advancePayment']

function validAmount(value) {
  if (value === '' || value === undefined || value === null) return true
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000
}

// Returns normalized commercial fields, or an error message.
function commercialFrom(input) {
  const body = input || {}
  if (!amountFields.every((field) => validAmount(body[field]))) return { error: 'Plant cost, subsidy and advance payment must be amounts of 0 or more.' }
  if (body.paymentTerms !== undefined && (typeof body.paymentTerms !== 'string' || body.paymentTerms.length > 200)) {
    return { error: 'Payment terms must be text up to 200 characters.' }
  }
  const values = Object.fromEntries(amountFields.map((field) => [
    field, body[field] === '' || body[field] === undefined || body[field] === null ? '' : Math.round(Number(body[field]) * 100) / 100,
  ]))
  if (values.totalPlantCost !== '' && values.advancePayment !== '' && values.advancePayment > values.totalPlantCost) {
    return { error: 'Advance payment cannot exceed the total plant cost.' }
  }
  return { values: { ...values, paymentTerms: (body.paymentTerms || '').trim() } }
}

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
  const commercial = commercialFrom(application)
  if (commercial.error) return res.status(400).json({ error: commercial.error })
  try {
    const created = {
      ...application,
      ...commercial.values,
      ocrDocument: null,
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

function findAccessible(data, req) {
  const found = data.applications.find((item) => item.id === req.params.id)
  if (!found) {
    const error = new Error('Solar application not found.')
    error.status = 404
    throw error
  }
  if (req.user.role !== 'admin' && found.assignedEmployeeId !== req.user.id) {
    const error = new Error('You can only access applications assigned to you.')
    error.status = 403
    throw error
  }
  return found
}

async function updateCommercial(req, res, next) {
  const commercial = commercialFrom(req.body)
  if (commercial.error) return res.status(400).json({ error: commercial.error })
  try {
    const application = await crmModel.update((data) => {
      const found = findAccessible(data, req)
      Object.assign(found, commercial.values)
      return found
    })
    res.json(application)
  } catch (error) {
    next(error)
  }
}

async function uploadOcrDocument(req, res, next) {
  const { document, fileName } = req.body || {}
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 200) {
    return res.status(400).json({ error: 'Provide the document and its file name.' })
  }
  try {
    const current = await crmModel.findAll()
    findAccessible(current, req)
    const stored = await uploadPrivateFile(document, `zxsolarcrm/application-ocr/${req.params.id}`)
    const application = await crmModel.update((data) => {
      const found = findAccessible(data, req)
      found.ocrDocument = {
        fileName: fileName.trim().replace(/[\\/]/g, '_'),
        ...stored,
        ocrStatus: 'Pending',
        uploadedAt: new Date().toISOString(),
        uploadedBy: req.user.name,
      }
      const customer = (data.customers || []).find((item) => item.id === found.customerId)
      if (customer) addCustomerEvent(customer, 'application', found.id, `OCR document uploaded for application ${found.applicationNumber}`)
      return found
    })
    res.status(201).json(application)
  } catch (error) {
    next(error)
  }
}

async function downloadOcrDocument(req, res, next) {
  try {
    const found = findAccessible(await crmModel.findAll(), req)
    if (!found.ocrDocument) return res.status(404).json({ error: 'No OCR document uploaded for this application.' })
    res.json({ url: privateDownloadUrl(found.ocrDocument), fileName: found.ocrDocument.fileName })
  } catch (error) {
    next(error)
  }
}

module.exports = { completeStep, create, decideApproval, downloadOcrDocument, updateCommercial, uploadOcrDocument }
