const crypto = require('node:crypto')
const config = require('../config')

const challenges = new Map()
const OTP_TTL_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5

function createError(message, status = 503) {
  const error = new Error(message)
  error.status = status
  return error
}

async function deliverSms(phone, otp) {
  const { accountSid, authToken, fromNumber } = config.twilio
  if (!accountSid || !authToken || !fromNumber) {
    throw createError('OTP delivery is not configured. Set Twilio credentials before requesting an OTP.')
  }
  if (typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw createError('The customer phone number must be saved in international format (for example, +919876543210).', 400)
  }

  const body = new URLSearchParams({
    To: phone,
    From: fromNumber,
    Body: `Your ZX Solar service verification code is ${otp}. It expires in 5 minutes.`,
  })
  const authorization = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) {
    const details = await response.json().catch(() => ({}))
    console.error('Twilio SMS delivery failed.', { status: response.status, code: details.code })
    throw createError('The OTP could not be delivered. Check the SMS provider configuration and try again.')
  }
}

async function issue(jobId, phone) {
  const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0')
  await deliverSms(phone, otp)
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.createHash('sha256').update(`${salt}:${otp}`).digest('hex')
  challenges.set(jobId, { hash, salt, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 })
  return { expiresInSeconds: OTP_TTL_MS / 1000 }
}

function verify(jobId, submittedOtp) {
  const challenge = challenges.get(jobId)
  if (!challenge || challenge.expiresAt < Date.now()) {
    challenges.delete(jobId)
    return { valid: false, status: 400, error: 'Request a new service OTP before verifying.' }
  }
  const submittedHash = crypto.createHash('sha256').update(`${challenge.salt}:${submittedOtp || ''}`).digest()
  const expectedHash = Buffer.from(challenge.hash, 'hex')
  if (!/^\d{4}$/.test(submittedOtp || '') || !crypto.timingSafeEqual(submittedHash, expectedHash)) {
    challenge.attempts += 1
    if (challenge.attempts >= MAX_ATTEMPTS) {
      challenges.delete(jobId)
      return { valid: false, status: 429, error: 'Too many incorrect attempts. Request a new OTP.' }
    }
    return { valid: false, status: 400, error: 'Invalid OTP.' }
  }
  challenges.delete(jobId)
  return { valid: true }
}

module.exports = { issue, verify }
