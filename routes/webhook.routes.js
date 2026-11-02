const express = require('express')
const webhookAuth = require('../middleware/webhookAuth')
const webhookController = require('../controllers/webhook.controller')

const router = express.Router()
router.post('/website', webhookAuth('WEBSITE_WEBHOOK_SECRET'), webhookController.website)
router.post('/referral', webhookAuth('REFERRAL_WEBHOOK_SECRET'), webhookController.referral)
router.post('/lead', webhookAuth('LEAD_WEBHOOK_SECRET'), webhookController.lead)

module.exports = router
