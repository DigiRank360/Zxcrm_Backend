const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')

async function create(req, res, next) {
  const { customer, phone, address, installDate } = req.body || {}
  if (typeof customer !== 'string' || !customer.trim() ||
      typeof phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(phone.trim()) ||
      typeof address !== 'string' || !address.trim() ||
      typeof installDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(installDate)) {
    return res.status(400).json({ error: 'Customer, phone, address, and a valid installation date are required.' })
  }
  try {
    const users = await userModel.findAll()
    const id = crypto.randomUUID()
    const installation = { id, customer: customer.trim(), phone: phone.trim(), address: address.trim(), installDate, status: 'Active' }
    const technicians = users.filter((user) => user.role === 'technician')
    const tickets = Array.from({ length: 4 }, (_, index) => {
      const dueDate = new Date(`${installDate}T00:00:00.000Z`)
      dueDate.setUTCMonth(dueDate.getUTCMonth() + (index + 1) * 3)
      return {
        id: crypto.randomUUID(),
        installationId: id,
        dueDate: dueDate.toISOString().slice(0, 10),
        workerId: technicians[index % Math.max(technicians.length, 1)]?.id || null,
        status: 'Pending',
      }
    })
    await crmModel.update((data) => {
      data.installations.push(installation)
      data.maintenance.push(...tickets)
    })
    res.status(201).json({ installation, maintenance: tickets })
  } catch (error) {
    next(error)
  }
}

module.exports = { create }
