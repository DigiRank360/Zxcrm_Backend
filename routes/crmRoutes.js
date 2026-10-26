const express = require('express')
const crmController = require('../controllers/crmController')
const { authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.get('/', crmController.getCrm)
router.put('/:resource', crmController.updateResource)

module.exports = router
