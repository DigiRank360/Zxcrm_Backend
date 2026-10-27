const express = require('express')
const visitController = require('../controllers/visitController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.get('/', allowRoles('admin', 'hr', 'employee'), visitController.list)
router.post('/', allowRoles('employee'), visitController.create)

module.exports = router
