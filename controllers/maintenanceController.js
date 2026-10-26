const crmModel = require('../models/crmModel')
const otpService = require('../services/otpService')

async function requestOtp(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const job = data.maintenance.find((item) => String(item.id) === req.params.id)
    if (!job) return res.status(404).json({ error: 'Service job not found.' })
    if (job.workerId !== req.user.id) return res.status(403).json({ error: 'This service job is assigned to another technician.' })
    if (job.status === 'Completed') return res.status(409).json({ error: 'This service job is already completed.' })
    const installation = data.installations.find((item) => item.id === job.installationId)
    const result = await otpService.issue(job.id, installation?.phone)
    res.json(result)
  } catch (error) {
    next(error)
  }
}

async function verifyOtp(req, res, next) {
  try {
    const result = otpService.verify(req.params.id, req.body?.otp)
    if (!result.valid) return res.status(result.status).json({ error: result.error })
    const job = await crmModel.update((data) => {
      const found = data.maintenance.find((item) => String(item.id) === req.params.id)
      if (!found) {
        const error = new Error('Service job not found.')
        error.status = 404
        throw error
      }
      if (found.workerId !== req.user.id) {
        const error = new Error('This service job is assigned to another technician.')
        error.status = 403
        throw error
      }
      if (found.status === 'Completed') {
        const error = new Error('This service job is already completed.')
        error.status = 409
        throw error
      }
      found.status = 'Completed'
      return found
    })
    res.json({ job })
  } catch (error) {
    next(error)
  }
}

module.exports = { requestOtp, verifyOtp }
