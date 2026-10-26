const crypto = require('node:crypto')
const config = require('../config')
const leadService = require('../services/leadService')

function verifyMetaSignature(req) {
  const secret = config.meta.appSecret
  const signature = req.get('x-hub-signature-256') || ''
  if (!secret || !signature.startsWith('sha256=') || !req.rawBody) return false
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest()
  let supplied
  try {
    supplied = Buffer.from(signature.slice(7), 'hex')
  } catch {
    return false
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
}

function verifyWebhook(req, res) {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query
  if (mode === 'subscribe' && token && token === config.meta.webhookVerifyToken) {
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
}

async function graphLead(leadId) {
  const token = config.meta.leadAccessToken
  const version = config.meta.graphApiVersion
  if (!token || !version) {
    const error = new Error('Meta Lead Ads integration is not configured.')
    error.status = 503
    throw error
  }
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(leadId)}`)
  url.searchParams.set('fields', 'id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name')
  url.searchParams.set('access_token', token)
  const response = await fetch(url)
  const result = await response.json()
  if (!response.ok) {
    console.error('Meta lead fetch failed.', { status: response.status, error: result.error?.message })
    const error = new Error('Meta could not return the lead details. Check the access token and permissions.')
    error.status = 502
    throw error
  }
  const fields = Object.fromEntries(
    (Array.isArray(result.field_data) ? result.field_data : [])
      .filter((field) => typeof field?.name === 'string')
      .map((field) => [field.name, field.values?.[0] || '']),
  )
  return {
    id: result.id || leadId,
    name: fields.full_name || fields.name || [fields.first_name, fields.last_name].filter(Boolean).join(' '),
    phone: fields.phone_number || fields.phone || fields.mobile_phone,
    email: fields.email || fields.email_address,
    notes: [result.campaign_name, result.adset_name, result.ad_name].filter(Boolean).join(' / '),
  }
}

async function metaEvent(req, res, next) {
  if (!verifyMetaSignature(req)) return res.status(401).json({ error: 'Invalid Meta webhook signature.' })
  try {
    const body = req.body || {}
    const leads = []
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen' && change.value?.leadgen_id) {
          leads.push(await graphLead(change.value.leadgen_id))
        }
      }
    }
    if (!leads.length) return res.status(200).json({ received: 0, created: 0 })
    const created = await leadService.ingest(leads, 'Meta Lead Ads')
    res.status(200).json({ received: leads.length, created: created.length })
  } catch (error) {
    next(error)
  }
}

async function intake(req, res, next) {
  const source = req.params.source
  const secret = config.leadWebhookSecrets[source]
  if (!secret) return res.status(503).json({ error: `The ${source} lead webhook is not configured.` })
  const supplied = req.get('x-api-key') || ''
  const expected = Buffer.from(secret)
  const actual = Buffer.from(supplied)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: 'Invalid lead webhook API key.' })
  }
  try {
    const created = await leadService.ingest(req.body?.leads || req.body, source === 'generic' ? 'API' : source[0].toUpperCase() + source.slice(1))
    res.status(201).json({ received: Array.isArray(req.body?.leads) ? req.body.leads.length : 1, created: created.length, leads: created })
  } catch (error) {
    next(error)
  }
}

function whatsappMessages(body) {
  return (body.entry || []).flatMap((entry) => (entry.changes || []).flatMap((change) => {
    if (change.field !== 'messages') return []
    const value = change.value || {}
    const contacts = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact.profile?.name]))
    return (value.messages || []).map((message) => ({
      id: message.id,
      name: contacts.get(message.from) || `WhatsApp ${message.from}`,
      phone: `+${message.from}`,
      notes: message.text?.body || `WhatsApp ${message.type || 'message'}`,
    }))
  }))
}

async function whatsappEvent(req, res, next) {
  if (!verifyMetaSignature(req)) return res.status(401).json({ error: 'Invalid WhatsApp webhook signature.' })
  try {
    const messages = whatsappMessages(req.body || {})
    if (!messages.length) return res.status(200).json({ received: 0, created: 0 })
    const created = await leadService.ingest(messages, 'WhatsApp')
    res.status(200).json({ received: messages.length, created: created.length })
  } catch (error) {
    next(error)
  }
}

async function integrations(req, res) {
  res.json({
    metaLeadAds: {
      configured: Boolean(config.meta.appSecret && config.meta.webhookVerifyToken && config.meta.leadAccessToken && config.meta.graphApiVersion),
      webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/meta`,
      verifyUrl: `${req.protocol}://${req.get('host')}/api/webhooks/meta`,
    },
    whatsapp: {
      configured: Boolean(config.meta.appSecret && config.meta.webhookVerifyToken),
      webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/whatsapp`,
      verifyUrl: `${req.protocol}://${req.get('host')}/api/webhooks/whatsapp`,
    },
    website: { configured: Boolean(config.leadWebhookSecrets.website), endpoint: '/api/webhooks/leads/website' },
    referral: { configured: Boolean(config.leadWebhookSecrets.referral), endpoint: '/api/webhooks/leads/referral' },
    generic: { configured: Boolean(config.leadWebhookSecrets.generic), endpoint: '/api/webhooks/leads/generic' },
  })
}

module.exports = { integrations, intake, metaEvent, verifyWebhook, whatsappEvent }
