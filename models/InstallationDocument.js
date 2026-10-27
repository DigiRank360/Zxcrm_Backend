const mongoose = require('mongoose')

const reviewSchema = new mongoose.Schema({
  status: { type: String, enum: ['Submitted', 'Verified', 'Approved', 'Rejected'], required: true },
  note: { type: String, default: '' },
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  occurredAt: { type: Date, default: Date.now },
}, { _id: false })

const installationDocumentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  installationId: { type: String, required: true, index: true },
  employeeId: { type: String, required: true, index: true },
  category: { type: String, enum: ['Valuation'], default: 'Valuation' },
  fileName: { type: String, required: true },
  mimeType: { type: String, required: true },
  publicId: { type: String, required: true },
  format: { type: String, required: true },
  status: { type: String, enum: ['Submitted', 'Verified', 'Approved', 'Rejected'], default: 'Submitted' },
  uploadedAt: { type: Date, default: Date.now },
  reviews: { type: [reviewSchema], default: [] },
}, { collection: 'installation_documents', versionKey: false })

module.exports = mongoose.models.InstallationDocument ||
  mongoose.model('InstallationDocument', installationDocumentSchema)
