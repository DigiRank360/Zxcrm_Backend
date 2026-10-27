const express = require('express')
const applicationController = require('../controllers/applicationController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.post('/', allowRoles('employee'), applicationController.create)
router.post('/:id/complete-step', allowRoles('employee'), applicationController.completeStep)
router.post('/:id/approval', allowRoles('admin'), applicationController.decideApproval)

module.exports = router
