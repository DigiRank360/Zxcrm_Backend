const express = require('express')
const customerController = require('../controllers/customerController')
const { authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.get('/', customerController.list)
router.get('/:id', customerController.get)

module.exports = router
