const mongoose = require('mongoose')

const crmStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'primary' },
  revision: { type: Number, default: 0 },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
}, {
  collection: 'crm_state',
  versionKey: false,
})

module.exports = mongoose.models.CrmState || mongoose.model('CrmState', crmStateSchema)
