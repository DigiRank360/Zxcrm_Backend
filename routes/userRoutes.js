const express = require('express')
const userController = require('../controllers/userController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin'))
router.get('/', userController.list)
router.post('/', userController.create)
router.patch('/:id', userController.update)
router.patch('/:id/routing', userController.updateRouting)
router.delete('/:id', userController.softDelete)
router.post('/:id/restore', userController.restore)

module.exports = router
