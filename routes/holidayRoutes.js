const express = require('express')
const holidayController = require('../controllers/holidayController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.get('/', holidayController.list)
router.post('/', allowRoles('admin', 'hr'), holidayController.create)
router.delete('/:id', allowRoles('admin', 'hr'), holidayController.remove)

module.exports = router
