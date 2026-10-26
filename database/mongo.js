const mongoose = require('mongoose')
const config = require('../config')

async function connectDatabase() {
  if (config.localTestStorage) return
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is required. Add your MongoDB connection string to Crm_Backend/.env.')
  }
  try {
    await mongoose.connect(config.mongodbUri, { serverSelectionTimeoutMS: 10000 })
  } catch (error) {
    console.error('MongoDB connection failed.', error.name)
    throw new Error('Unable to connect to MongoDB. Check MONGODB_URI and database network access.')
  }
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
}

module.exports = { connectDatabase, disconnectDatabase }
