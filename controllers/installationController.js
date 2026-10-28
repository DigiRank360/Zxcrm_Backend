const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { addCustomerEvent, findOrCreateCustomer } = require('../services/customerService')

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function create(req, res, next) {
  const { customer, phone, address, installDate, email = '', state = '', city = '', propertyType = '' } = req.body || {}
  if (typeof customer !== 'string' || !customer.trim() ||
      typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone.trim()) ||
      typeof address !== 'string' || !address.trim() ||
      !validDate(installDate) ||
      [email, state, city, propertyType].some((value) => typeof value !== 'string')) {
    return res.status(400).json({ error: 'Customer, phone, address, and a valid installation date are required.' })
  }
  try {
    const users = await userModel.findAll()
    const id = crypto.randomUUID()
    const technicians = users.filter((user) => user.role === 'technician' && user.active !== false)
    const customerDetails = { name: customer.trim(), customer: customer.trim(), phone: phone.trim(), address: address.trim(), email, state, city, propertyType }
    const installation = {
      id,
      ...customerDetails,
      installDate,
      status: 'Active',
      ...(req.user.role === 'employee' ? { assignedEmployeeId: req.user.id } : {}),
    }
    const tickets = Array.from({ length: 4 }, (_, index) => {
      const dueDate = new Date(`${installDate}T00:00:00.000Z`)
      dueDate.setUTCMonth(dueDate.getUTCMonth() + (index + 1) * 3)
      return {
        id: crypto.randomUUID(),
        installationId: id,
        title: 'Quarterly maintenance',
        description: 'Scheduled preventive maintenance visit.',
        type: 'AMC',
        dueDate: dueDate.toISOString().slice(0, 10),
        workerId: technicians[index % Math.max(technicians.length, 1)]?.id || null,
        status: 'Pending',
      }
    })
    await crmModel.update((data) => {
      const record = findOrCreateCustomer(data, customerDetails)
      installation.customerId = record.id
      for (const ticket of tickets) ticket.customerId = record.id
      data.installations.push(installation)
      data.maintenance.push(...tickets)
      addCustomerEvent(record, 'installation', id, `Installation scheduled for ${installDate}`)
    })
    res.status(201).json({ installation, maintenance: tickets })
  } catch (error) {
    next(error)
  }
}

async function assignEmployee(req, res, next) {
  const { employeeId } = req.body || {}
  if (employeeId !== null && typeof employeeId !== 'string') {
    return res.status(400).json({ error: 'Provide an employee ID or null to unassign.' })
  }
  try {
    const users = await userModel.findAll()
    const employee = employeeId === null ? null : users.find((user) => user.id === employeeId && user.role === 'employee')
    if (employeeId !== null && !employee) {
      return res.status(400).json({ error: 'Select an active employee.' })
    }
    const result = await crmModel.update((data) => {
      const installation = data.installations.find((item) => item.id === req.params.installationId)
      if (!installation) {
        const error = new Error('Installation not found.')
        error.status = 404
        throw error
      }
      const application = (data.applications || []).find((item) => item.id === installation.applicationId)
      installation.assignedEmployeeId = employee?.id || null
      installation.assignedEmployeeName = employee?.name || ''
      if (application) {
        application.assignedEmployeeId = employee?.id || null
        application.assignedEmployeeName = employee?.name || ''
      }
      if (installation.customerId) {
        const customer = (data.customers || []).find((item) => item.id === installation.customerId)
        if (customer) {
          addCustomerEvent(
            customer,
            'installation',
            installation.id,
            employee ? `Installation assigned to ${employee.name}` : 'Installation unassigned',
          )
        }
      }
      return { installation, application: application || null }
    })
    res.json(result)
  } catch (error) {
    next(error)
  }
}

module.exports = { assignEmployee, create }
