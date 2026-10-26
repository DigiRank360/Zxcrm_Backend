const express = require('express')
const applicationController = require('../controllers/applicationController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin'))
router.post('/', applicationController.create)
router.post('/:id/complete-step', applicationController.completeStep)

module.exports = router
