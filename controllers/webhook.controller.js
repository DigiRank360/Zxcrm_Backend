const leadService = require('../services/leadService')

function fail(res, message) {
  return res.status(400).json({ success: false, message })
}

function receive(source, validate) {
  return async (req, res, next) => {
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 'Request body must be a JSON object.')
    const problem = validate(body)
    if (problem) return fail(res, problem)
    try {
      const created = await leadService.ingest(body, source)
      res.status(created.length ? 201 : 200).json({
        success: true,
        duplicate: !created.length,
        message: created.length ? 'Lead received' : 'Duplicate webhook event ignored',
        leadId: created[0]?.id || null,
      })
    } catch (error) {
      next(error)
    }
  }
}

const hasText = (value) => typeof value === 'string' && value.trim()
const contactProblem = (body) =>
  (hasText(body.name || body.full_name) && hasText(body.phone || body.phone_number)) ? '' : 'name and phone are required.'

const website = receive('Website', contactProblem)
const referral = receive('Referral', (body) => contactProblem(body) || (hasText(body.referralName) ? '' : 'referralName is required.'))
const lead = receive('API', contactProblem)

module.exports = { lead, referral, website }
