const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const testUri = process.env.CRM_TEST_MONGODB_URI

test('MongoDB CRM concurrency and API compatibility', { skip: !testUri }, async (t) => {
  const uri = new URL(testUri)
  if (uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1' || uri.username || uri.password) {
    throw new Error('CRM_TEST_MONGODB_URI must be an unauthenticated MongoDB instance on 127.0.0.1.')
  }
  uri.pathname = `/crm_test_${crypto.randomUUID().replace(/-/g, '')}`
  process.env.NODE_ENV = 'mongo-integration'
  process.env.MONGODB_URI = uri.toString()
  process.env.ADMIN_USERNAME = 'mongo-test-admin'
  process.env.ADMIN_PASSWORD = 'Mongo_Test_Password_123!'
  process.env.ADMIN_NAME = 'Mongo Test Admin'
  const mongoose = require('mongoose')
  const { app, initializeData } = require('./server')
  const crm = require('./models/crmModel')
  const users = require('./models/userModel')
  let server
  t.after(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await mongoose.disconnect()
  })

  await mongoose.connect(process.env.MONGODB_URI)
  const hello = await mongoose.connection.db.admin().command({ hello: 1 })
  if (!hello.setName || !hello.isWritablePrimary) throw new Error('An isolated local replica-set primary is required.')
  await mongoose.connection.collection('crm_state').insertOne({
    _id: 'primary',
    revision: 3,
    data: {
      applications: [{
        id: 'legacy-application',
        customer: 'Legacy Customer',
        phone: '+15550000003',
        applicationNumber: 'legacy-number',
        steps: Array.from({ length: 7 }, () => ({ startedAt: '', completedAt: '' })),
      }],
    },
  })
  await initializeData()
  await t.test('legacy customers and applications migrate without repeated writes', async () => {
    const application = (await crm.findResource('applications'))[0]
    const customer = (await crm.findResource('customers'))[0]
    assert.equal(application.steps.length, 12)
    assert.equal(application.customerId, customer.id)
    const keys = ['leads', 'attendance', 'installations', 'maintenance', 'applications', 'customers']
    const before = await Promise.all(keys.map((key) =>
      mongoose.connection.collection(`crm_${key}`).findOne({ _id: 'primary' })))
    const { migrateCustomers } = require('./services/customerService')
    const { migrateApplications } = require('./config/applicationWorkflow')
    await crm.updateResources(keys, (data) => {
      migrateCustomers(data)
      migrateApplications(data)
    })
    const after = await Promise.all(keys.map((key) =>
      mongoose.connection.collection(`crm_${key}`).findOne({ _id: 'primary' })))
    assert.deepEqual(after, before)
  })
  const first = await users.create({ name: 'First Employee', username: 'mongo-first', password: 'Mongo_First_Password_123!', role: 'employee' })
  const second = await users.create({ name: 'Second Employee', username: 'mongo-second', password: 'Mongo_Second_Password_123!', role: 'employee' })
  await users.create({ name: 'Test HR', username: 'mongo-hr', password: 'Mongo_Hr_Password_123!', role: 'hr' })
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  async function request(url, method = 'GET', token, body) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  async function login(username, password) {
    const response = await request('/api/auth/login', 'POST', null, { username, password })
    assert.equal(response.status, 200)
    return response.body.token
  }
  const admin = await login('mongo-test-admin', process.env.ADMIN_PASSWORD)
  const firstToken = await login('mongo-first', 'Mongo_First_Password_123!')
  const secondToken = await login('mongo-second', 'Mongo_Second_Password_123!')
  const hr = await login('mongo-hr', 'Mongo_Hr_Password_123!')
  async function createLead(name, phone) {
    const response = await request('/api/leads/manual', 'POST', firstToken, { name, phone })
    assert.equal(response.status, 201)
    return response.body.lead
  }
  const leadA = await createLead('Test A', '+15550000001')
  const leadB = await createLead('Test B', '+15550000002')

  await t.test('projected reads match stored fields without returning other fields', async () => {
    const projected = await crm.findProjectedResources({ leads: ['id', 'status'], customers: ['id'] })
    const full = await crm.findResources(['leads', 'customers'])
    assert.deepEqual(projected.leads, full.leads.map(({ id, status }) => ({ id, status })))
    assert.deepEqual(projected.customers, full.customers.map(({ id }) => ({ id })))
    assert.equal((await request('/api/crm/summary', 'GET', admin)).status, 200)
    assert.equal((await request('/api/crm/summary', 'GET', firstToken)).status, 403)
  })

  await t.test('lead updates preserve authorization and response contracts', async () => {
    assert.equal((await request(`/api/leads/${leadA.id}`, 'PATCH', secondToken, { notes: 'blocked' })).status, 403)
    assert.equal((await request(`/api/leads/${leadA.id}/assign`, 'PATCH', secondToken, { agentId: second.id })).status, 403)
    const update = await request(`/api/leads/${leadA.id}`, 'PATCH', admin, { notes: 'admin edit' })
    assert.equal(update.status, 200)
    assert.equal(update.body.id, leadA.id)
    assert.equal(update.body.notes, 'admin edit')
    const transfer = await request(`/api/leads/${leadA.id}/assign`, 'PATCH', firstToken, { agentId: second.id })
    assert.equal(transfer.status, 200)
    assert.equal(transfer.body.lead.agentId, second.id)
    assert.equal((await request(`/api/leads/${leadA.id}/assign`, 'PATCH', firstToken, { agentId: first.id })).status, 403)
  })

  await t.test('simultaneous updates to the same and different leads are retained', async () => {
    const results = await Promise.all([
      request(`/api/leads/${leadA.id}`, 'PATCH', admin, { notes: 'same-lead notes' }),
      request(`/api/leads/${leadA.id}`, 'PATCH', admin, { city: 'same-lead city' }),
      request(`/api/leads/${leadB.id}`, 'PATCH', admin, { notes: 'other-lead notes' }),
    ])
    assert.deepEqual(results.map((result) => result.status), [200, 200, 200])
    const leads = await crm.findResource('leads')
    assert.equal(leads.find((lead) => lead.id === leadA.id).notes, 'same-lead notes')
    assert.equal(leads.find((lead) => lead.id === leadA.id).city, 'same-lead city')
    assert.equal(leads.find((lead) => lead.id === leadB.id).notes, 'other-lead notes')
  })

  await t.test('different resource writes and no-op attendance do not overwrite each other', async () => {
    await Promise.all([
      crm.updateResource('attendance', (data) => data.attendance.push({ id: 'attendance-1', date: '2026-01-01' })),
      crm.updateResource('payroll', (data) => data.payroll.push({ id: 'payroll-1', month: '2026-01', status: 'Pending' })),
    ])
    const before = await mongoose.connection.collection('crm_attendance').findOne({ _id: 'primary' })
    await crm.updateResource('attendance', () => {})
    const after = await mongoose.connection.collection('crm_attendance').findOne({ _id: 'primary' })
    assert.equal(after.revision, before.revision)
    assert.equal((await crm.findResource('payroll'))[0].id, 'payroll-1')
    assert.equal((await crm.findResource('leads')).length, 2)
    const attendance = await request('/api/crm/attendance', 'PUT', admin, [{ id: 'attendance-1', date: '2026-01-01', status: 'Present' }])
    assert.equal(attendance.status, 200)
    assert.equal(attendance.body[0].status, 'Present')
    const payroll = await request('/api/hr/payroll/payroll-1/paid', 'PATCH', hr)
    assert.equal(payroll.status, 200)
    assert.equal(payroll.body.status, 'Paid')
  })

  await t.test('change detection preserves BSON values that JSON cannot distinguish', async () => {
    await crm.updateResource('leaveRequests', (data) => data.leaveRequests.push({ id: 'legacy-value', value: NaN }))
    await crm.updateResource('leaveRequests', (data) => { data.leaveRequests[0].value = null })
    assert.equal((await crm.findResource('leaveRequests'))[0].value, null)
  })

  await t.test('a forced same-resource race retries against fresh data', async () => {
    let arrivals = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const write = (id, field, value) => crm.updateResource('leads', async (data) => {
      arrivals += 1
      if (arrivals <= 2) {
        if (arrivals === 2) release()
        await gate
      }
      data.leads.find((lead) => lead.id === id)[field] = value
    }, { retrySafe: true })
    await Promise.all([write(leadA.id, 'city', 'race-city'), write(leadB.id, 'notes', 'race-notes')])
    const leads = await crm.findResource('leads')
    assert.equal(leads.find((lead) => lead.id === leadA.id).city, 'race-city')
    assert.equal(leads.find((lead) => lead.id === leadB.id).notes, 'race-notes')
    assert.ok(arrivals >= 3)
  })

  await t.test('failure after the first transactional write rolls back all resources', async () => {
    const before = await crm.findResources(['leads', 'customers'])
    const collection = mongoose.connection.collection('crm_customers')
    const original = collection.updateOne
    collection.updateOne = async () => { throw new Error('Injected write failure') }
    try {
      await assert.rejects(crm.updateResources(['leads', 'customers'], (data) => {
        data.leads[0].notes = 'must roll back'
        data.customers[0].name = 'must roll back'
      }), /Injected write failure/)
    } finally {
      collection.updateOne = original
    }
    assert.deepEqual(await crm.findResources(['leads', 'customers']), before)
  })

  await t.test('multi-resource reads observe one transaction snapshot', async () => {
    const before = await crm.findResources(['leads', 'customers'])
    const collection = mongoose.connection.collection('crm_leads')
    const original = collection.findOne
    let started
    let release
    const readStarted = new Promise((resolve) => { started = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    let blocked = false
    collection.findOne = async function (...args) {
      const row = await original.apply(this, args)
      if (!blocked && args[1]?.session) {
        blocked = true
        started()
        await gate
      }
      return row
    }
    try {
      const snapshotPromise = crm.findResources(['leads', 'customers'])
      await readStarted
      await crm.updateResources(['leads', 'customers'], (data) => {
        data.leads[0].notes = 'committed together'
        data.customers[0].name = 'committed together'
      })
      release()
      assert.deepEqual(await snapshotPromise, before)
    } finally {
      release()
      collection.findOne = original
    }
  })

  await t.test('lead removal retains its existing permanent-delete contract', async () => {
    const result = await request(`/api/leads/${leadB.id}`, 'DELETE', firstToken)
    assert.equal(result.status, 200)
    assert.equal(result.body.lead.id, leadB.id)
    assert.equal(result.body.lead.deletedAt, undefined)
    assert.equal((await crm.findResource('leads')).some((lead) => lead.id === leadB.id), false)
    const dashboard = await request('/api/crm', 'GET', admin)
    assert.equal(dashboard.status, 200)
    assert.ok(Array.isArray(dashboard.body.leads))
    assert.ok(Array.isArray(dashboard.body.attendance))
    assert.equal(dashboard.body.leads.some((lead) => lead.id === leadB.id), false)
  })
})
