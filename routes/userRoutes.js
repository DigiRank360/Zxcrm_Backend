const express = require('express')
const userController = require('../controllers/userController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin'))
router.get('/', userController.list)
router.post('/', userController.create)

module.exports = router
