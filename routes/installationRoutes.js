const express = require('express')
const installationController = require('../controllers/installationController')
const installationDocumentController = require('../controllers/installationDocumentController')
const { authenticate, allowRoles } = require('../middleware/authMiddleware')

const router = express.Router()
router.use(authenticate, allowRoles('admin', 'employee'))
router.patch('/:installationId/assign', allowRoles('admin'), installationController.assignEmployee)
router.get('/:installationId/valuation-documents', installationDocumentController.list)
router.post('/:installationId/valuation-documents', allowRoles('employee'), installationDocumentController.upload)
router.get('/:installationId/valuation-documents/:documentId/download', installationDocumentController.download)
router.patch('/:installationId/valuation-documents/:documentId/review', allowRoles('admin'), installationDocumentController.review)
router.post('/', (req, res) => res.status(409).json({ error: 'Create a solar application and complete its workflow; commissioning creates the installation and maintenance schedule.' }))

module.exports = router
