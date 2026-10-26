const express = require('express')
const leadController = require('../controllers/leadController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.post('/auto-assign', authenticate, allowRoles('admin'), leadController.autoAssign)

module.exports = router
