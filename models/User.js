const mongoose = require('mongoose')

const userSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: { type: String, required: true, enum: ['admin', 'employee', 'technician'] },
  phone: { type: String, default: '' },
  active: { type: Boolean, default: true },
  passwordHash: { type: String, required: true, select: false },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'users',
  versionKey: false,
})

module.exports = mongoose.models.User || mongoose.model('User', userSchema)
