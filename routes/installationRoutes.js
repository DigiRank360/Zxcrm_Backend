const express = require('express')
const installationController = require('../controllers/installationController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin'))
router.post('/', installationController.create)

module.exports = router
