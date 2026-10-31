const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  contactEmail: { type: String, default: '' },
  role: { type: String, required: true, enum: ['admin', 'hr', 'employee', 'technician'] },
  phone: { type: String, default: '' },
  active: { type: Boolean, default: true },
  maxOpenLeads: { type: Number, min: 0 },
  serviceAreas: { type: [String], default: [] },
  propertyTypes: { type: [String], default: [] },
  minLeadScore: { type: Number, min: 0, max: 100 },
  maxLeadScore: { type: Number, min: 0, max: 100 },
  deletedAt: { type: Date },
  passwordHash: { type: String, required: true, select: false },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'users',
  versionKey: false,
})

module.exports = mongoose.models.User || mongoose.model('User', userSchema)
