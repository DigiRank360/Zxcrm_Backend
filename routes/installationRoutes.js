const express = require('express')
const { authenticate, allowRoles } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin', 'employee'))
router.post('/', (req, res) => res.status(409).json({ error: 'Create a solar application and complete its workflow; commissioning creates the installation and maintenance schedule.' }))

module.exports = router
