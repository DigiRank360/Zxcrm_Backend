const express = require('express')
const uploadController = require('../controllers/uploadController')
const { authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.post('/', uploadController.create)

module.exports = router
