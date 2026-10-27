const express = require('express')
const maintenanceController = require('../controllers/maintenanceController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.post('/', allowRoles('employee'), maintenanceController.create)
router.patch('/:id', allowRoles('employee'), maintenanceController.assign)
router.post('/:id/otp', allowRoles('technician'), maintenanceController.requestOtp)
router.post('/:id/verify-otp', allowRoles('technician'), maintenanceController.verifyOtp)

module.exports = router
