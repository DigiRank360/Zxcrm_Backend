const express = require('express')
const leadWebhookController = require('../controllers/leadWebhookController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.get('/meta', leadWebhookController.verifyWebhook)
router.post('/meta', leadWebhookController.metaEvent)
router.get('/whatsapp', leadWebhookController.verifyWebhook)
router.post('/whatsapp', leadWebhookController.whatsappEvent)
router.post('/leads/:source', leadWebhookController.intake)
router.get('/integrations', authenticate, allowRoles('admin'), leadWebhookController.integrations)

module.exports = router
