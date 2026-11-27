const express = require('express')
const crmController = require('../controllers/crmController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.get('/', crmController.getCrm)
router.get('/summary', allowRoles('admin'), crmController.getDashboardSummary)
router.get('/views/:view', crmController.getView)
router.put('/:resource', crmController.updateResource)

module.exports = router
