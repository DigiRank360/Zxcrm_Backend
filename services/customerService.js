const crypto = require('node:crypto')

function normalizedPhone(phone) {
  return String(phone || '').replace(/\D/g, '')
}

function findOrCreateCustomer(data, details = {}) {
  const phone = String(details.phone || '').trim()
  const email = String(details.email || '').trim().toLowerCase()
  const phoneKey = normalizedPhone(phone)
  const customer = data.customers.find((item) =>
    (phoneKey && normalizedPhone(item.phone) === phoneKey) ||
    (email && item.email?.toLowerCase() === email))
  const now = new Date().toISOString()
  if (customer) {
    for (const key of ['name', 'phone', 'email', 'address', 'state', 'city', 'propertyType']) {
      if (details[key] && !customer[key]) customer[key] = details[key]
    }
    customer.updatedAt = now
    return customer
  }
  const created = {
    id: crypto.randomUUID(),
    name: String(details.name || details.customer || 'Customer').trim(),
    phone,
    email,
    address: String(details.address || '').trim(),
    state: String(details.state || '').trim(),
    city: String(details.city || '').trim(),
    propertyType: String(details.propertyType || '').trim(),
    createdAt: now,
    updatedAt: now,
    history: [],
  }
  data.customers.push(created)
  return created
}

function addCustomerEvent(customer, type, recordId, summary) {
  customer.history ||= []
  customer.history.push({
    id: crypto.randomUUID(),
    type,
    recordId,
    summary,
    occurredAt: new Date().toISOString(),
  })
  customer.updatedAt = new Date().toISOString()
}

function migrateCustomers(data) {
  for (const key of ['leads', 'attendance', 'installations', 'maintenance', 'applications']) {
    if (!Array.isArray(data[key])) data[key] = []
  }
  data.customers ||= []
  for (const lead of data.leads || []) {
    const customer = findOrCreateCustomer(data, {
      name: lead.name, phone: lead.phone, email: lead.email, state: lead.state,
      city: lead.city, propertyType: lead.propertyType,
    })
    lead.customerId ||= customer.id
    if (!customer.history.some((event) => event.recordId === lead.id)) {
      addCustomerEvent(customer, 'lead', lead.id, `Lead received from ${lead.source || 'CRM'}`)
    }
  }
  for (const application of data.applications || []) {
    const customer = findOrCreateCustomer(data, {
      name: application.customer, phone: application.phone, email: application.email,
      address: application.address, state: application.state, city: application.city,
    })
    application.customerId ||= customer.id
    if (!customer.history.some((event) => event.recordId === application.id)) {
      addCustomerEvent(customer, 'application', application.id, `Solar application ${application.applicationNumber || ''} created`.trim())
    }
  }
  for (const installation of data.installations || []) {
    const customer = findOrCreateCustomer(data, {
      name: installation.customer, phone: installation.phone, email: installation.email,
      address: installation.address, state: installation.state, city: installation.city,
    })
    installation.customerId ||= customer.id
    if (!customer.history.some((event) => event.recordId === installation.id)) {
      addCustomerEvent(customer, 'installation', installation.id, 'Solar installation recorded')
    }
  }
  for (const ticket of data.maintenance || []) {
    if (!ticket.customerId && ticket.installationId) {
      const installation = data.installations.find((item) => item.id === ticket.installationId)
      if (installation) ticket.customerId = installation.customerId
    }
  }
}

module.exports = { addCustomerEvent, findOrCreateCustomer, migrateCustomers }
