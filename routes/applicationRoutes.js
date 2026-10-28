const express = require('express')
const applicationController = require('../controllers/applicationController')
const { allowRoles, authenticate } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate)
router.post('/', allowRoles('employee'), applicationController.create)
router.patch('/:id/commercial', allowRoles('admin', 'employee'), applicationController.updateCommercial)
router.post('/:id/ocr-document', allowRoles('admin', 'employee'), applicationController.uploadOcrDocument)
router.get('/:id/ocr-document/download', allowRoles('admin', 'employee'), applicationController.downloadOcrDocument)
router.post('/:id/complete-step', allowRoles('employee'), applicationController.completeStep)
router.post('/:id/approval', allowRoles('admin'), applicationController.decideApproval)

module.exports = router
