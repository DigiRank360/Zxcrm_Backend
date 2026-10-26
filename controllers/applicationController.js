const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')

async function create(req, res, next) {
  const application = req.body
  if (!application || typeof application !== 'object' || Array.isArray(application) ||
      !application.customer || !application.phone || !application.applicationNumber ||
      !Array.isArray(application.steps) || application.steps.length !== 7) {
    return res.status(400).json({ error: 'Provide the consumer, application number, and all workflow steps.' })
  }
  try {
    const created = { ...application, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    await crmModel.update((data) => {
      if (data.applications.some((item) => item.applicationNumber === created.applicationNumber)) {
        const error = new Error('This application number already exists.')
        error.status = 409
        throw error
      }
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
      const stage = found.steps.findIndex((step) => !step.completedAt)
      if (stage < 0) {
        const error = new Error('All workflow steps are already completed.')
        error.status = 409
        throw error
      }
      const now = new Date().toISOString()
      found.steps[stage].completedAt = now
      if (found.steps[stage + 1]) found.steps[stage + 1].startedAt = now
      return found
    })
    res.json(application)
  } catch (error) {
    next(error)
  }
}

module.exports = { completeStep, create }
