const express = require('express')
const maintenanceController = require('../controllers/maintenanceController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('technician'))
router.post('/:id/otp', maintenanceController.requestOtp)
router.post('/:id/verify-otp', maintenanceController.verifyOtp)

module.exports = router
