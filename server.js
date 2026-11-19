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
  const { autoCheckoutOpenAttendance } = require('./services/attendanceService')
  const userModel = require('./models/userModel')
  const runAutoCheckout = async () => {
    const users = await userModel.findAll({ includeInactive: false })
    const employees = users.filter((user) => user.role === 'employee')
    await autoCheckoutOpenAttendance({
      ids: employees.map((user) => user.id),
      names: employees.map((user) => user.name),
    })
  }
  runAutoCheckout().catch((error) => console.error('Attendance auto-checkout failed.', error.name))
  const autoCheckoutTimer = setInterval(() => {
    runAutoCheckout().catch((error) => console.error('Attendance auto-checkout failed.', error.name))
  }, 60 * 1000)
  autoCheckoutTimer.unref()
  const crmModel = require('./models/crmModel')
  const otpService = require('./services/otpService')
  const { currentMaintenanceTickets } = require('./services/maintenanceService')
  const runMaintenanceReminders = async () => {
    const data = await crmModel.findAll()
    const today = new Date()
    for (const ticket of currentMaintenanceTickets(data.maintenance)) {
      if (ticket.type !== 'AMC' || ticket.status !== 'Pending' || ticket.reminderSentAt) continue
      if (!ticket.dueDate) continue
      const due = new Date(`${ticket.dueDate}T00:00:00.000Z`)
      const days = Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
      if (days < 0 || days > 10) continue
      const customer = (data.customers || []).find((item) => item.id === ticket.customerId)
      if (!customer?.phone) continue
      try {
        await otpService.sendMaintenanceReminder(customer.phone, customer.name, ticket.dueDate, ticket.title)
        await crmModel.update((current) => {
          const found = current.maintenance.find((item) => item.id === ticket.id)
          if (found) found.reminderSentAt = new Date().toISOString()
        })
      } catch (error) {
        console.error('Maintenance reminder failed.', { ticketId: ticket.id, error: error.message })
      }
    }
  }
  runMaintenanceReminders().catch((error) => console.error('Maintenance reminder scan failed.', error.name))
  const maintenanceReminderTimer = setInterval(() => {
    runMaintenanceReminders().catch((error) => console.error('Maintenance reminder scan failed.', error.name))
  }, 10 * 60 * 1000)
  maintenanceReminderTimer.unref()
  server.on('close', () => {
    clearInterval(autoCheckoutTimer)
    clearInterval(maintenanceReminderTimer)
    disconnectDatabase().catch((error) => console.error('MongoDB disconnect failed.', error.name))
  })
  return server
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Unable to start the CRM API.', error)
    process.exitCode = 1
  })
}

module.exports = { app, initializeData, start }
