const express = require('express')
const leadController = require('../controllers/leadController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.post('/auto-assign', authenticate, allowRoles('admin'), leadController.autoAssign)
router.post('/import', authenticate, allowRoles('admin'), leadController.importLeads)
router.patch('/:id', authenticate, allowRoles('admin', 'employee'), leadController.update)
router.patch('/:id/transfer-location', authenticate, allowRoles('admin', 'employee'), leadController.transferLocation)
router.patch('/:id/assign', authenticate, allowRoles('admin'), leadController.assign)

module.exports = router
