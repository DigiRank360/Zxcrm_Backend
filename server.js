const app = require('./app')
const crmModel = require('./models/crmModel')
const userModel = require('./models/userModel')
const config = require('./config')
const { connectDatabase, disconnectDatabase } = require('./database/mongo')

async function initializeData() {
  await connectDatabase()
  await crmModel.initialize()
  await userModel.initializeAdmin()
}

async function start() {
  await initializeData()
  const server = app.listen(config.port, () => console.log(`ZX Solar CRM API listening on port ${config.port}`))
  server.on('close', () => disconnectDatabase().catch((error) => console.error('MongoDB disconnect failed.', error.name)))
  return server
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start the CRM API.', error)
    process.exitCode = 1
  })
}

module.exports = { app, initializeData, start }
