const { after, before, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const testDataDirectory = path.join(__dirname, '.test-data')
fs.rmSync(testDataDirectory, { recursive: true, force: true })
fs.mkdirSync(testDataDirectory, { recursive: true })
process.env.NODE_ENV = 'test'
process.env.CRM_DATA_FILE = path.join(testDataDirectory, 'crm.json')
process.env.CRM_USERS_FILE = path.join(testDataDirectory, 'users.json')
process.env.ADMIN_USERNAME = 'test-admin@example.com'
process.env.ADMIN_PASSWORD = 'Test_Admin_Password_123!'
process.env.ADMIN_NAME = 'Test Admin'
process.env.META_APP_SECRET = 'test-meta-app-secret'
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-meta-verify-token'
process.env.META_LEAD_ACCESS_TOKEN = 'test-meta-access-token'
process.env.META_GRAPH_API_VERSION = 'v24.0'
process.env.WEBSITE_WEBHOOK_SECRET = 'website-test-key'
process.env.REFERRAL_WEBHOOK_SECRET = 'referral-test-key'
process.env.TWILIO_ACCOUNT_SID = 'test-account'
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token'
process.env.TWILIO_FROM_NUMBER = '+15005550006'
process.env.HR_DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const { app, initializeData } = require('./server')
let server
let baseUrl
let adminToken
let technicianToken
let employeeToken
let recipientToken
let employee
let recipient
let technician

async function request(endpoint, { token, ...options } = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  return { response, body: await response.json().catch(() => ({})) }
}

async function signIn(username, password) {
  const { response, body } = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200)
  return body
}

async function uploadApplicationStageDocument(applicationId, stage, token = employeeToken) {
  const oldEnv = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    url: process.env.CLOUDINARY_URL,
  }
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
  process.env.CLOUDINARY_API_KEY = 'test-key'
  process.env.CLOUDINARY_API_SECRET = 'test-secret'
  process.env.CLOUDINARY_URL = ''
  const originalFetch = global.fetch
  global.fetch = async (url, options) => String(url).startsWith('https://api.cloudinary.com/')
    ? new Response(JSON.stringify({ public_id: 'zxsolarcrm/applications/test/stage/document', format: 'pdf' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : originalFetch(url, options)
  try {
    const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`
    return await request(`/api/applications/${applicationId}/steps/${stage}/documents`, {
      method: 'POST',
      token,
      body: JSON.stringify({ fileName: `stage-${stage}.pdf`, document: pdf }),
    })
  } finally {
    global.fetch = originalFetch
    for (const [key, value] of Object.entries({
      CLOUDINARY_CLOUD_NAME: oldEnv.cloudName,
      CLOUDINARY_API_KEY: oldEnv.apiKey,
      CLOUDINARY_API_SECRET: oldEnv.apiSecret,
      CLOUDINARY_URL: oldEnv.url,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

before(async () => {
  await initializeData()
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  adminToken = (await signIn('TEST-ADMIN@EXAMPLE.COM', process.env.ADMIN_PASSWORD)).token
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  fs.rmSync(testDataDirectory, { recursive: true, force: true })
})

test('health endpoint reports readiness and new CRM storage is empty', async () => {
  const health = await request('/api/health')
  assert.equal(health.response.status, 200)
  assert.deepEqual(health.body, { status: 'ok' })

  const crm = await request('/api/crm', { token: adminToken })
  assert.equal(crm.response.status, 200)
  assert.deepEqual(crm.body.leads, [])
  assert.deepEqual(crm.body.attendance, [])
  assert.deepEqual(crm.body.installations, [])
  assert.deepEqual(crm.body.maintenance, [])
  assert.deepEqual(crm.body.applications, [])
  assert.deepEqual(crm.body.customers, [])
  assert.equal(crm.body.users.length, 1)
})

test('legacy CRM records migrate into persistent customer profiles idempotently', () => {
  const { migrateCustomers } = require('./services/customerService')
  const data = {
    leads: [{ id: 'legacy-lead', name: 'Legacy Customer', phone: '+919800000009', source: 'Website' }],
    attendance: [], installations: [], maintenance: [], applications: [],
  }
  migrateCustomers(data)
  assert.equal(data.customers.length, 1)
  assert.equal(data.leads[0].customerId, data.customers[0].id)
  assert.equal(data.customers[0].history[0].recordId, 'legacy-lead')
  migrateCustomers(data)
  assert.equal(data.customers.length, 1)
  assert.equal(data.customers[0].history.length, 1)
})

test('legacy seven-step applications migrate to the extended sequential workflow', () => {
  const { migrateApplications } = require('./config/applicationWorkflow')
  const oldSteps = Array.from({ length: 7 }, () => ({ startedAt: '', completedAt: '' }))
  oldSteps[0] = { startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T01:00:00.000Z' }
  oldSteps[4] = { startedAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-02T01:00:00.000Z' }
  oldSteps[5] = { startedAt: '2026-01-03T00:00:00.000Z', completedAt: '2026-01-03T01:00:00.000Z' }
  oldSteps[6] = { startedAt: '2026-01-04T00:00:00.000Z', completedAt: '', approvalStatus: 'Approved' }
  const data = { applications: [{ id: 'legacy-app', steps: oldSteps }] }
  assert.equal(migrateApplications(data), true)
  assert.equal(data.applications[0].steps.length, 12)
  assert.equal(data.applications[0].steps[6].completedAt, oldSteps[5].completedAt)
  assert.equal(data.applications[0].steps[7].completedAt, oldSteps[5].completedAt)
  assert.equal(data.applications[0].steps[8].approvalStatus, 'Approved')
  assert.equal(data.applications[0].steps[9].completedAt, '')
  assert.equal(migrateApplications(data), false)
})

test('admin creates persisted employee and technician credentials', async () => {
  const createdEmployee = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Dynamic Employee',
      username: 'dynamic.employee@example.com',
      password: 'Employee_Password_123!',
      role: 'employee',
      phone: '+919876543210',
    }),
  })
  assert.equal(createdEmployee.response.status, 201)
  assert.equal(createdEmployee.body.passwordHash, undefined)
  employee = createdEmployee.body
  const storedUsers = JSON.parse(fs.readFileSync(process.env.CRM_USERS_FILE, 'utf8'))
  const storedEmployee = storedUsers.find((user) => user.id === employee.id)
  assert.notEqual(storedEmployee.passwordHash, 'Employee_Password_123!')
  assert.equal(storedEmployee.passwordHash.includes('Employee_Password_123!'), false)
  const login = await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')
  employeeToken = login.token
  assert.equal(login.user.id, employee.id)
  assert.equal(login.user.role, 'employee')

  const createdRecipient = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Lead Recipient',
      username: 'lead.recipient',
      password: 'Recipient_Password_123!',
      role: 'employee',
      maxOpenLeads: 0,
    }),
  })
  assert.equal(createdRecipient.response.status, 201)
  recipient = createdRecipient.body
  recipientToken = (await signIn('lead.recipient', 'Recipient_Password_123!')).token

  const duplicate = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Duplicate',
      username: 'DYNAMIC.EMPLOYEE@EXAMPLE.COM',
      password: 'Different_Password_123!',
      role: 'employee',
    }),
  })
  assert.equal(duplicate.response.status, 409)

  const createdTechnician = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Dynamic Technician',
      username: 'dynamic-tech',
      password: 'Technician_Password_123!',
      role: 'technician',
      phone: '+919876543211',
    }),
  })
  assert.equal(createdTechnician.response.status, 201)
  technician = createdTechnician.body
  technicianToken = (await signIn('dynamic-tech', 'Technician_Password_123!')).token
})

test('CRM requires authentication and role authorization', async () => {
  const anonymous = await request('/api/crm')
  assert.equal(anonymous.response.status, 401)

  const forbidden = await request('/api/users', { token: technicianToken })
  assert.equal(forbidden.response.status, 403)
})

test('website lead webhook validates, deduplicates, and assigns an employee', async () => {
  const payload = {
    name: 'Website Contact',
    phone: '+919800000001',
    email: 'customer@example.com',
    state: 'Maharashtra',
    city: 'Pune',
    propertyType: 'Residential',
    score: 82,
    message: 'Interested in solar',
    externalId: 'website-form-001',
  }
  const first = await request('/api/webhooks/leads/website', {
    method: 'POST',
    headers: { 'x-api-key': 'website-test-key' },
    body: JSON.stringify(payload),
  })
  assert.equal(first.response.status, 201)
  assert.equal(first.body.created, 1)
  assert.equal(first.body.leads[0].agentId, employee.id)
  assert.equal(first.body.leads[0].source, 'Website')
  assert.equal(first.body.leads[0].city, 'Pune')
  assert.match(first.body.leads[0].assignmentReason, /geography Pune, Maharashtra/)

  const duplicate = await request('/api/webhooks/leads/website', {
    method: 'POST',
    headers: { 'x-api-key': 'website-test-key' },
    body: JSON.stringify(payload),
  })
  assert.equal(duplicate.response.status, 201)
  assert.equal(duplicate.body.created, 0)

  const employeeCrm = await request('/api/crm', { token: (await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')).token })
  assert.equal(employeeCrm.body.leads.length, 1)
  assert.equal(employeeCrm.body.leads[0].name, 'Website Contact')
  assert.deepEqual(employeeCrm.body.installations, [])
  assert.deepEqual(employeeCrm.body.maintenance, [])
  assert.deepEqual(employeeCrm.body.applications, [])
  assert.ok(employeeCrm.body.users.some((user) => user.id === employee.id))
  assert.ok(employeeCrm.body.users.every((user) => user.id === employee.id || user.role === 'technician'))
  assert.ok(employeeCrm.body.users.every((user) => !user.passwordHash))
  const customerProfiles = await request('/api/customers', { token: (await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')).token })
  assert.equal(customerProfiles.response.status, 200)
  assert.equal(customerProfiles.body.length, 1)
  assert.equal(customerProfiles.body[0].leads[0].name, 'Website Contact')
  assert.deepEqual(customerProfiles.body[0].installations, [])
})

test('Meta webhook verification and signed WhatsApp lead intake work', async () => {
  const verify = await fetch(`${baseUrl}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-meta-verify-token&hub.challenge=challenge-123`)
  assert.equal(verify.status, 200)
  assert.equal(await verify.text(), 'challenge-123')

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          contacts: [{ wa_id: '919876500000', profile: { name: 'WhatsApp Customer' } }],
          messages: [{ id: 'wamid-test-1', from: '919876500000', type: 'text', text: { body: 'Need a solar quote' } }],
        },
      }],
    }],
  }
  const rawBody = JSON.stringify(payload)
  const signature = require('node:crypto').createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')
  const first = await request('/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${signature}` },
    body: rawBody,
  })
  assert.equal(first.response.status, 200)
  assert.equal(first.body.created, 1)

  const duplicatePayload = structuredClone(payload)
  duplicatePayload.entry[0].changes[0].value.messages[0].id = 'wamid-test-2'
  const duplicateRaw = JSON.stringify(duplicatePayload)
  const duplicateSignature = require('node:crypto').createHmac('sha256', process.env.META_APP_SECRET).update(duplicateRaw).digest('hex')
  const duplicate = await request('/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': `sha256=${duplicateSignature}` },
    body: duplicateRaw,
  })
  assert.equal(duplicate.response.status, 200)
  assert.equal(duplicate.body.created, 0)
})

test('signed Meta Lead Ads webhooks fetch form data and enter the central pool', async () => {
  const payload = {
    object: 'page',
    entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'meta-lead-1' } }] }],
  }
  const rawBody = JSON.stringify(payload)
  const signature = require('node:crypto').createHmac('sha256', process.env.META_APP_SECRET).update(rawBody).digest('hex')
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      const graphUrl = new URL(url)
      assert.equal(graphUrl.pathname, '/v24.0/meta-lead-1')
      assert.equal(graphUrl.searchParams.get('fields').split(',').includes('platform'), false)
      return new Response(JSON.stringify({
        id: 'meta-lead-1',
        field_data: [
          { name: 'Full Name', values: ['Meta Ads Customer'] },
          { name: 'Phone Number', values: ['+919876500001'] },
          { name: 'Email Address', values: ['meta@example.com'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return originalFetch(url, options)
  }
  let result
  try {
    result = await request('/api/webhooks/meta', {
      method: 'POST',
      headers: { 'x-hub-signature-256': `sha256=${signature}` },
      body: rawBody,
    })
  } finally {
    global.fetch = originalFetch
  }
  assert.equal(result.response.status, 200)
  assert.equal(result.body.created, 1)
  const crm = await request('/api/crm', { token: adminToken })
  const metaLead = crm.body.leads.find((lead) => lead.name === 'Meta Ads Customer' && lead.source === 'Meta Lead Ads')
  assert.ok(metaLead)
  assert.equal(metaLead.phone, '+919876500001')
  assert.equal(metaLead.email, 'meta@example.com')
  const integrations = await request('/api/webhooks/integrations', { token: adminToken })
  assert.equal(integrations.body.metaLeadAds.configured, true)
})

test('solar applications and workflow stages persist through the API', async () => {
  const application = {
    customer: 'Dynamic Consumer',
    phone: '+919876543212',
    applicationNumber: 'APP-TEST-1',
    steps: Array.from({ length: 7 }, (_, index) => ({
      startedAt: index === 0 ? new Date().toISOString() : '',
      completedAt: '',
    })),
  }
  const created = await request('/api/applications', {
    method: 'POST',
    token: employeeToken,
    body: JSON.stringify(application),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.assignedEmployeeId, employee.id)
  assert.equal((await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })).response.status, 409)
  assert.equal((await uploadApplicationStageDocument(created.body.id, 1)).response.status, 409)
  let uploaded = await uploadApplicationStageDocument(created.body.id, 0)
  assert.equal(uploaded.response.status, 201)
  assert.equal(uploaded.body.steps[0].documents.length, 1)
  const adminProgress = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: adminToken })
  assert.equal(adminProgress.response.status, 403)
  let completed = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })
  assert.equal(completed.response.status, 200)
  assert.ok(completed.body.steps[0].completedAt)
  assert.ok(completed.body.steps[1].startedAt)
  await uploadApplicationStageDocument(created.body.id, 1)
  completed = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })
  assert.equal(completed.response.status, 200)
  const blocked = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })
  assert.equal(blocked.response.status, 409)
  const employeeApproval = await request(`/api/applications/${created.body.id}/approval`, {
    method: 'POST', token: employeeToken, body: JSON.stringify({ decision: 'Approved', note: '' }),
  })
  assert.equal(employeeApproval.response.status, 403)
  const missingReason = await request(`/api/applications/${created.body.id}/approval`, {
    method: 'POST', token: adminToken, body: JSON.stringify({ decision: 'Rejected', note: '' }),
  })
  assert.equal(missingReason.response.status, 400)
  const rejected = await request(`/api/applications/${created.body.id}/approval`, {
    method: 'POST', token: adminToken, body: JSON.stringify({ decision: 'Rejected', note: 'Awaiting utility documents' }),
  })
  assert.equal(rejected.response.status, 200)
  assert.equal(rejected.body.steps[2].approvalStatus, 'Rejected')
  assert.equal((await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })).response.status, 409)
  const approved = await request(`/api/applications/${created.body.id}/approval`, {
    method: 'POST', token: adminToken, body: JSON.stringify({ decision: 'Approved', note: 'Feasibility passed' }),
  })
  assert.equal(approved.response.status, 200)
  assert.equal(approved.body.steps[2].approvalStatus, 'Approved')
  assert.equal(approved.body.approvalHistory.length, 2)
  await uploadApplicationStageDocument(created.body.id, 2)
  completed = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: employeeToken })
  assert.equal(completed.response.status, 200)
  assert.ok(completed.body.steps[3].startedAt)

  const otherEmployee = await request('/api/users', {
    method: 'POST', token: adminToken,
    body: JSON.stringify({
      name: 'Other Employee',
      username: 'other.employee',
      password: 'Other_Employee_Password_123!',
      role: 'employee',
      serviceAreas: ['Other'],
      propertyTypes: ['Industrial'],
    }),
  })
  assert.equal(otherEmployee.response.status, 201)
  const otherEmployeeToken = (await signIn('other.employee', 'Other_Employee_Password_123!')).token
  assert.equal((await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: otherEmployeeToken })).response.status, 403)
  const transferred = await request(`/api/applications/${created.body.id}/transfer`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ employeeId: otherEmployee.body.id }),
  })
  assert.equal(transferred.response.status, 200)
  assert.equal(transferred.body.assignedEmployeeId, otherEmployee.body.id)
  assert.equal(transferred.body.transferHistory[0].stage, 3)
  assert.equal((await uploadApplicationStageDocument(created.body.id, 3, employeeToken)).response.status, 403)
  await uploadApplicationStageDocument(created.body.id, 3, otherEmployeeToken)
  const otherCompleted = await request(`/api/applications/${created.body.id}/complete-step`, { method: 'POST', token: otherEmployeeToken })
  assert.equal(otherCompleted.response.status, 200)

  const crm = await request('/api/crm', { token: adminToken })
  assert.ok(crm.body.applications.some((item) => item.applicationNumber === 'APP-TEST-1'))
  const employeeCrm = await request('/api/crm', { token: employeeToken })
  assert.equal(employeeCrm.body.applications.some((item) => item.applicationNumber === 'APP-TEST-1'), false)
  assert.equal(employeeCrm.body.applications.some((item) => item.assignedEmployeeId === otherEmployee.body.id), false)
  const otherEmployeeCrm = await request('/api/crm', { token: otherEmployeeToken })
  assert.ok(otherEmployeeCrm.body.applications.some((item) => item.applicationNumber === 'APP-TEST-1'))
  const adminCannotCreate = await request('/api/applications', {
    method: 'POST', token: adminToken, body: JSON.stringify(application),
  })
  assert.equal(adminCannotCreate.response.status, 403)
})

test('application commercial details and OCR document are stored via Cloudinary', async () => {
  const body = {
    customer: 'Commercial Consumer', phone: '+919876543299', applicationNumber: 'APP-COMM-1',
    totalPlantCost: 300000, subsidyAmount: 78000, paymentTerms: '50% advance, 50% on commissioning', advancePayment: 150000,
    steps: Array.from({ length: 7 }, (_, index) => ({ startedAt: index === 0 ? new Date().toISOString() : '', completedAt: '' })),
  }
  assert.equal((await request('/api/applications', { method: 'POST', token: employeeToken, body: JSON.stringify({ ...body, applicationNumber: 'APP-COMM-BAD', advancePayment: 400000 }) })).response.status, 400)
  const created = await request('/api/applications', { method: 'POST', token: employeeToken, body: JSON.stringify(body) })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.advancePayment, 150000)
  const updated = await request(`/api/applications/${created.body.id}/commercial`, {
    method: 'PATCH', token: employeeToken, body: JSON.stringify({ ...body, advancePayment: 200000 }),
  })
  assert.equal(updated.body.advancePayment, 200000)

  const oldEnv = { n: process.env.CLOUDINARY_CLOUD_NAME, k: process.env.CLOUDINARY_API_KEY, s: process.env.CLOUDINARY_API_SECRET, u: process.env.CLOUDINARY_URL }
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
  process.env.CLOUDINARY_API_KEY = 'test-key'
  process.env.CLOUDINARY_API_SECRET = 'test-secret'
  process.env.CLOUDINARY_URL = ''
  const originalFetch = global.fetch
  global.fetch = async (url, options) => String(url).startsWith('https://api.cloudinary.com/')
    ? new Response(JSON.stringify({ public_id: 'zxsolarcrm/application-ocr/x/id', format: 'pdf' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : originalFetch(url, options)
  try {
    const pdf = `data:application/pdf;base64,${Buffer.from('%PDF-1.4 test').toString('base64')}`
    const path = `/api/applications/${created.body.id}/ocr-document`
    assert.equal((await request(path, { method: 'POST', token: employeeToken, body: JSON.stringify({ fileName: 'a.txt', document: 'data:text/plain;base64,aGk=' }) })).response.status, 400)
    const uploaded = await request(path, { method: 'POST', token: employeeToken, body: JSON.stringify({ fileName: 'bill.pdf', document: pdf }) })
    assert.equal(uploaded.response.status, 201)
    assert.equal(uploaded.body.ocrDocument.fileName, 'bill.pdf')
    const link = await request(`${path}/download`, { token: adminToken })
    assert.equal(link.response.status, 200)
    assert.ok(link.body.url.startsWith('https://'))
  } finally {
    global.fetch = originalFetch
    for (const [key, value] of Object.entries({ CLOUDINARY_CLOUD_NAME: oldEnv.n, CLOUDINARY_API_KEY: oldEnv.k, CLOUDINARY_API_SECRET: oldEnv.s, CLOUDINARY_URL: oldEnv.u })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('leads transfer between locations with tracked history', async () => {
  const imported = await request('/api/leads/import', {
    method: 'POST', token: adminToken,
    body: JSON.stringify([{ name: 'Transfer Lead', phone: '+919811112233', source: 'CSV', state: 'Madhya Pradesh', city: 'Bhopal', propertyType: 'Residential', score: 50 }]),
  })
  assert.equal(imported.response.status, 201)
  const lead = imported.body.leads[0]
  const path = `/api/leads/${lead.id}/transfer-location`
  assert.equal((await request(path, { method: 'PATCH', token: adminToken, body: JSON.stringify({ state: '', city: 'Delhi' }) })).response.status, 400)
  assert.equal((await request(path, { method: 'PATCH', token: adminToken, body: JSON.stringify({ state: 'Madhya Pradesh', city: 'Bhopal' }) })).response.status, 400)
  const moved = await request(path, { method: 'PATCH', token: adminToken, body: JSON.stringify({ state: 'Delhi', city: 'New Delhi', note: 'Customer relocated' }) })
  assert.equal(moved.response.status, 200)
  assert.equal(moved.body.lead.city, 'New Delhi')
  assert.equal(moved.body.lead.transfers[0].fromCity, 'Bhopal')
  assert.equal(moved.body.lead.transfers[0].transferredBy.length > 0, true)
  const byEmployee = await request(path, { method: 'PATCH', token: employeeToken, body: JSON.stringify({ state: 'Delhi', city: 'Dwarka' }) })
  assert.equal(byEmployee.response.status, moved.body.lead.agentId === employee.id ? 200 : 403)
  const unassigned = await request(`/api/leads/${lead.id}/assign`, { method: 'PATCH', token: adminToken, body: JSON.stringify({ agentId: null }) })
  assert.equal(unassigned.response.status, 200)
  assert.equal((await request(path, { method: 'PATCH', token: employeeToken, body: JSON.stringify({ state: 'Delhi', city: 'Rohini' }) })).response.status, 403)
})

test('employees can manually create leads assigned to themselves', async () => {
  const created = await request('/api/leads/manual', {
    method: 'POST',
    token: employeeToken,
    body: JSON.stringify({
      name: 'Manual Queue Lead',
      phone: '+919811112299',
      email: 'manual@example.com',
      state: 'Madhya Pradesh',
      city: 'Bhopal',
      propertyType: 'Residential',
      notes: 'Asked for a solar quote.',
    }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.lead.name, 'Manual Queue Lead')
  assert.equal(created.body.lead.source, 'Manual')
  assert.equal(created.body.lead.status, 'New')
  assert.equal(created.body.lead.agentId, employee.id)
  assert.equal(created.body.lead.city, 'Bhopal')

  const employeeCrm = await request('/api/crm', { token: employeeToken })
  assert.ok(employeeCrm.body.leads.some((lead) => lead.id === created.body.lead.id))

  const notInterested = await request(`/api/leads/${created.body.lead.id}`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ status: 'Not Interested' }),
  })
  assert.equal(notInterested.response.status, 200)
  assert.ok((await request('/api/crm', { token: employeeToken })).body.leads.some((lead) => lead.id === created.body.lead.id && lead.status === 'Not Interested'))

  const otherStatus = await request(`/api/leads/${created.body.lead.id}`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ status: 'Other', notes: 'Customer requested a callback by email.' }),
  })
  assert.equal(otherStatus.response.status, 200)
  assert.equal(otherStatus.body.status, 'Other')

  assert.equal((await request(`/api/leads/${created.body.lead.id}`, { method: 'DELETE', token: recipientToken })).response.status, 403)
  const archived = await request(`/api/leads/${created.body.lead.id}`, { method: 'DELETE', token: employeeToken })
  assert.equal(archived.response.status, 200)
  assert.ok(archived.body.lead.deletedAt)
  assert.equal((await request('/api/crm', { token: employeeToken })).body.leads.some((lead) => lead.id === created.body.lead.id), false)
  assert.ok((await request('/api/crm', { token: adminToken })).body.leads.some((lead) => lead.id === created.body.lead.id && lead.deletedAt))
  assert.equal((await request(`/api/leads/${created.body.lead.id}`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ status: 'Interested' }),
  })).response.status, 409)

  const restored = await request(`/api/leads/${created.body.lead.id}/restore`, { method: 'POST', token: adminToken })
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.lead.deletedAt, undefined)
  assert.ok((await request('/api/crm', { token: employeeToken })).body.leads.some((lead) => lead.id === created.body.lead.id))

  const invalid = await request('/api/leads/manual', {
    method: 'POST',
    token: employeeToken,
    body: JSON.stringify({ name: '', phone: '' }),
  })
  assert.equal(invalid.response.status, 400)
  assert.equal((await request('/api/leads/manual', { method: 'POST', token: adminToken, body: JSON.stringify({ name: 'Forbidden', phone: '+919811112200' }) })).response.status, 403)
})

test('employees can transfer an owned lead to another employee dashboard', async () => {
  const imported = await request('/api/leads/import', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify([{ name: 'Employee Handoff', phone: '+919811112244', source: 'CSV' }]),
  })
  assert.equal(imported.response.status, 201)
  const lead = imported.body.leads[0]
  assert.equal(lead.agentId, employee.id)

  const sourceCrm = await request('/api/crm', { token: employeeToken })
  assert.equal(sourceCrm.response.status, 200)
  assert.ok(sourceCrm.body.agents.some((agent) => agent.id === recipient.id && agent.name === recipient.name))

  const transferred = await request(`/api/leads/${lead.id}/assign`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ agentId: recipient.id }),
  })
  assert.equal(transferred.response.status, 200)
  assert.equal(transferred.body.lead.agentId, recipient.id)
  assert.match(transferred.body.lead.assignmentReason, /Transferred by/)

  const oldOwnerCrm = await request('/api/crm', { token: employeeToken })
  assert.equal(oldOwnerCrm.body.leads.some((item) => item.id === lead.id), false)
  const recipientCrm = await request('/api/crm', { token: recipientToken })
  assert.equal(recipientCrm.response.status, 200)
  assert.ok(recipientCrm.body.leads.some((item) => item.id === lead.id))

  const previousOwnerTransfer = await request(`/api/leads/${lead.id}/assign`, {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ agentId: employee.id }),
  })
  assert.equal(previousOwnerTransfer.response.status, 403)
})

test('lead routing matches geography, property and score with active capacity limits', async () => {
  const configured = await request(`/api/users/${employee.id}/routing`, {
    method: 'PATCH', token: adminToken,
    body: JSON.stringify({ maxOpenLeads: 10, serviceAreas: ['Other'], propertyTypes: ['Industrial'], minLeadScore: 0, maxLeadScore: 100 }),
  })
  assert.equal(configured.response.status, 200)
  const constrained = await request('/api/users', {
    method: 'POST', token: adminToken,
    body: JSON.stringify({
      name: 'Pune Residential Agent', username: 'pune.agent', password: 'Pune_Agent_Password_123!',
      role: 'employee', maxOpenLeads: 1, serviceAreas: ['Pune', 'Maharashtra'],
      propertyTypes: ['Residential'], minLeadScore: 70, maxLeadScore: 90,
    }),
  })
  assert.equal(constrained.response.status, 201)
  const leads = await request('/api/leads/import', {
    method: 'POST', token: adminToken,
    body: JSON.stringify([
      { name: 'Routed Customer', phone: '+919800000100', state: 'Maharashtra', city: 'Pune', propertyType: 'Residential', score: 82 },
      { name: 'Capacity Overflow', phone: '+919800000101', state: 'Maharashtra', city: 'Pune', propertyType: 'Residential', score: 82 },
    ]),
  })
  assert.equal(leads.response.status, 201)
  assert.equal(leads.body.leads[0].agentId, constrained.body.id)
  assert.match(leads.body.leads[0].assignmentReason, /lowest normalized open-lead load/)
  assert.equal(leads.body.leads[1].agentId, null)
  assert.match(leads.body.leads[1].assignmentReason, /capacity/)
  const incompatible = await request(`/api/leads/${leads.body.leads[0].id}/assign`, {
    method: 'PATCH', token: adminToken, body: JSON.stringify({ agentId: employee.id }),
  })
  assert.equal(incompatible.response.status, 409)
  const customerResponse = await request('/api/customers', { token: adminToken })
  assert.equal(customerResponse.response.status, 200)
  const profile = customerResponse.body.find((customer) => customer.phone === '+919800000100')
  assert.ok(profile)
  assert.equal(profile.leads.length, 1)
  assert.equal(profile.city, 'Pune')
  const editedLead = await request(`/api/leads/${leads.body.leads[0].id}`, {
    method: 'PATCH',
    token: adminToken,
    body: JSON.stringify({ name: 'Edited Routed Customer', score: 88, notes: 'Follow up tomorrow' }),
  })
  assert.equal(editedLead.response.status, 200)
  assert.equal(editedLead.body.name, 'Edited Routed Customer')
  assert.equal(editedLead.body.score, 88)
})

test('only commissioning creates an installation and quarterly maintenance jobs', async () => {
  const bypass = await request('/api/installations', {
    method: 'POST',
    token: employeeToken,
    body: JSON.stringify({
      customer: 'Dynamic Solar Customer',
      phone: '+919876543210',
      address: 'Test address',
      installDate: '2026-01-15',
    }),
  })
  assert.equal(bypass.response.status, 409)

  const application = await request('/api/applications', {
    method: 'POST', token: employeeToken,
    body: JSON.stringify({
      customer: 'Dynamic Solar Customer',
      phone: '+919876543210',
      applicationNumber: 'APP-QUARTERLY-1',
      address: 'Test address',
      steps: Array.from({ length: 12 }, () => ({ startedAt: '', completedAt: '' })),
    }),
  })
  assert.equal(application.response.status, 201)
  let completed
  for (let stage = 0; stage <= 9; stage += 1) {
    const uploaded = await uploadApplicationStageDocument(application.body.id, stage)
    assert.equal(uploaded.response.status, 201)
    if ([2, 8].includes(stage)) {
      const approval = await request(`/api/applications/${application.body.id}/approval`, {
        method: 'POST', token: adminToken,
        body: JSON.stringify({ decision: 'Approved', note: 'Inspection approved' }),
      })
      assert.equal(approval.response.status, 200)
    }
    completed = await request(`/api/applications/${application.body.id}/complete-step`, { method: 'POST', token: employeeToken })
    assert.equal(completed.response.status, 200)
  }
  assert.equal(completed.body.commissionedTickets.length, 4)
  assert.ok(completed.body.commissionedTickets.every((job) => job.workerId === null))
  const employeeCrm = await request('/api/crm', { token: employeeToken })
  assert.equal(employeeCrm.body.installations.length, 1)
  assert.equal(employeeCrm.body.maintenance.length, 4)
  assert.equal(employeeCrm.body.installations[0].customer, 'Dynamic Solar Customer')
  const employeeCustomers = await request('/api/customers', { token: employeeToken })
  const commissionedCustomer = employeeCustomers.body.find((item) => item.name === 'Dynamic Solar Customer')
  assert.ok(commissionedCustomer)
  assert.equal(commissionedCustomer.applications[0].applicationNumber, 'APP-QUARTERLY-1')
  assert.equal(commissionedCustomer.installations.length, 1)

  const pastInstallationEmployee = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Past Installation Employee',
      username: 'past.installation.employee',
      password: 'Past_Installation_Employee_123!',
      role: 'employee',
    }),
  })
  assert.equal(pastInstallationEmployee.response.status, 201)
  const pastEmployeeToken = (await signIn('past.installation.employee', 'Past_Installation_Employee_123!')).token
  const installation = employeeCrm.body.installations[0]
  const unauthorizedAssignment = await request(`/api/installations/${installation.id}/assign`, {
    method: 'PATCH',
    token: pastEmployeeToken,
    body: JSON.stringify({ employeeId: pastInstallationEmployee.body.id }),
  })
  assert.equal(unauthorizedAssignment.response.status, 403)
  const assigned = await request(`/api/installations/${installation.id}/assign`, {
    method: 'PATCH',
    token: adminToken,
    body: JSON.stringify({ employeeId: pastInstallationEmployee.body.id }),
  })
  assert.equal(assigned.response.status, 200)
  assert.equal(assigned.body.installation.assignedEmployeeId, pastInstallationEmployee.body.id)
  assert.equal(assigned.body.application.assignedEmployeeId, pastInstallationEmployee.body.id)
  const pastEmployeeCrm = await request('/api/crm', { token: pastEmployeeToken })
  assert.ok(pastEmployeeCrm.body.installations.some((item) => item.id === installation.id))
  assert.ok(pastEmployeeCrm.body.applications.some((item) => item.id === application.body.id))
  const originalEmployeeCrm = await request('/api/crm', { token: employeeToken })
  assert.equal(originalEmployeeCrm.body.installations.some((item) => item.id === installation.id), false)
  const restored = await request(`/api/installations/${installation.id}/assign`, {
    method: 'PATCH',
    token: adminToken,
    body: JSON.stringify({ employeeId: employee.id }),
  })
  assert.equal(restored.response.status, 200)
})

test('employee creates a detailed service ticket, admin is read-only, and only assigned technician can access it', async () => {
  const profile = await request('/api/customers', { token: adminToken })
  const customer = profile.body.find((item) => item.name === 'Dynamic Solar Customer')
  assert.ok(customer)
  const created = await request('/api/maintenance', {
    method: 'POST', token: employeeToken,
    body: JSON.stringify({
      customerId: customer.id,
      installationId: customer.installations[0].id,
      title: 'Inverter not responding',
      description: 'Customer reports no display on inverter.',
      priority: 'High',
      dueDate: '2026-11-02',
      workerId: technician.id,
    }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.ticket.title, 'Inverter not responding')
  const adminWrite = await request('/api/maintenance', { method: 'POST', token: adminToken, body: JSON.stringify({}) })
  assert.equal(adminWrite.response.status, 403)
  const adminPatch = await request(`/api/maintenance/${created.body.ticket.id}`, { method: 'PATCH', token: adminToken, body: JSON.stringify({ priority: 'Low' }) })
  assert.equal(adminPatch.response.status, 403)
  const adminView = await request('/api/crm', { token: adminToken })
  assert.ok(adminView.body.maintenance.some((item) => item.id === created.body.ticket.id))
  const employeeView = await request('/api/crm', { token: employeeToken })
  assert.ok(employeeView.body.maintenance.some((item) => item.id === created.body.ticket.id))
  const otherEmployeeToken = (await signIn('other.employee', 'Other_Employee_Password_123!')).token
  const crossEmployeeCreate = await request('/api/maintenance', {
    method: 'POST', token: otherEmployeeToken,
    body: JSON.stringify({
      customerId: customer.id,
      installationId: customer.installations[0].id,
      title: 'Unauthorized ticket',
      dueDate: '2026-11-03',
    }),
  })
  assert.equal(crossEmployeeCreate.response.status, 403)
  const crossEmployeePatch = await request(`/api/maintenance/${created.body.ticket.id}`, {
    method: 'PATCH', token: otherEmployeeToken, body: JSON.stringify({ priority: 'Urgent' }),
  })
  assert.equal(crossEmployeePatch.response.status, 403)
  const noInstall = await request('/api/maintenance', { method: 'POST', token: employeeToken, body: JSON.stringify({ customerId: customer.id, title: 'x', dueDate: '2026-11-02' }) })
  assert.equal(noInstall.response.status, 400)
  const technicianCrm = await request('/api/crm', { token: technicianToken })
  assert.ok(technicianCrm.body.maintenance.some((item) => item.id === created.body.ticket.id))
  const forbidden = await request(`/api/maintenance/${created.body.ticket.id}/otp`, { method: 'POST', token: employeeToken })
  assert.equal(forbidden.response.status, 403)
  const employeeProfile = await request(`/api/customers/${customer.id}`, { token: employeeToken })
  assert.equal(employeeProfile.response.status, 200)
  assert.ok(employeeProfile.body.applications.some((item) => item.applicationNumber === 'APP-QUARTERLY-1'))
  const isolated = await request(`/api/customers/${customer.id}`, { token: otherEmployeeToken })
  assert.equal(isolated.response.status, 404)
  const profileResponse = await request(`/api/customers/${customer.id}`, { token: technicianToken })
  assert.equal(profileResponse.response.status, 200)
  assert.ok(profileResponse.body.tickets.some((item) => item.id === created.body.ticket.id))
})

test('service OTP is sent through Twilio and required to complete a job', async () => {
  const originalFetch = global.fetch
  let sentOtp
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.twilio.com/')) {
      const message = new URLSearchParams(options.body).get('Body')
      sentOtp = message.match(/code is (\d{4})/)?.[1]
      return new Response(JSON.stringify({ sid: 'test-message' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return originalFetch(url, options)
  }

  let otpResponse
  const jobs = (await request('/api/crm', { token: technicianToken })).body.maintenance
  const job = jobs.find((item) => item.title === 'Inverter not responding') || jobs[0]
  try {
    otpResponse = await request(`/api/maintenance/${encodeURIComponent(job.id)}/otp`, {
      method: 'POST',
      token: technicianToken,
    })
  } finally {
    global.fetch = originalFetch
  }
  assert.equal(otpResponse.response.status, 200)
  assert.equal(otpResponse.body.otp, undefined)
  assert.match(sentOtp, /^\d{4}$/)

  const invalid = await request(`/api/maintenance/${job.id}/verify-otp`, {
    method: 'POST',
    token: technicianToken,
    body: JSON.stringify({ otp: sentOtp === '9999' ? '0000' : '9999' }),
  })
  assert.equal(invalid.response.status, 400)

  const verified = await request(`/api/maintenance/${job.id}/verify-otp`, {
    method: 'POST',
    token: technicianToken,
    body: JSON.stringify({ otp: sentOtp }),
  })
  assert.equal(verified.response.status, 200)
  assert.equal(verified.body.job.status, 'Completed')
})

test('admins can edit, soft-delete, and restore employee accounts', async () => {
  const created = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Account To Manage',
      username: 'account.manage',
      password: 'Account_Password_123!',
      role: 'employee',
      phone: '+919800000099',
    }),
  })
  assert.equal(created.response.status, 201)

  const employeeToken = (await signIn('account.manage', 'Account_Password_123!')).token
  const updated = await request(`/api/users/${created.body.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: JSON.stringify({
      name: 'Updated Account',
      username: 'account.updated',
      phone: '+919800000098',
      password: 'Updated_Password_123!',
      maxOpenLeads: 12,
      serviceAreas: ['Pune'],
      propertyTypes: ['Residential'],
      minLeadScore: 10,
      maxLeadScore: 90,
    }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.name, 'Updated Account')
  assert.equal(updated.body.username, 'account.updated')
  assert.equal(updated.body.passwordHash, undefined)
  assert.equal((await request('/api/crm', { token: employeeToken })).response.status, 401)
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'account.manage', password: 'Account_Password_123!' }),
  })).response.status, 401)
  assert.equal((await signIn('account.updated', 'Updated_Password_123!')).user.id, created.body.id)

  const beforeDeleteToken = (await signIn('account.updated', 'Updated_Password_123!')).token
  const deleted = await request(`/api/users/${created.body.id}`, { method: 'DELETE', token: adminToken })
  assert.equal(deleted.response.status, 200)
  assert.equal(deleted.body.active, false)
  assert.ok(deleted.body.deletedAt)
  assert.equal((await request('/api/crm', { token: beforeDeleteToken })).response.status, 401)
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'account.updated', password: 'Updated_Password_123!' }),
  })).response.status, 401)
  assert.ok((await request('/api/users', { token: adminToken })).body.some((user) => user.id === created.body.id && user.deletedAt))

  const restored = await request(`/api/users/${created.body.id}/restore`, { method: 'POST', token: adminToken })
  assert.equal(restored.response.status, 200)
  assert.equal(restored.body.active, true)
  assert.equal(restored.body.deletedAt, undefined)
  assert.equal((await signIn('account.updated', 'Updated_Password_123!')).user.id, created.body.id)

  const adminDelete = await request(`/api/users/${(await request('/api/users', { token: adminToken })).body.find((user) => user.role === 'admin').id}`, {
    method: 'DELETE',
    token: adminToken,
  })
  assert.equal(adminDelete.response.status, 404)
})

test('commissioning creates the installation and quarterly maintenance schedule', async () => {
  const application = await request('/api/applications', {
    method: 'POST',
    token: employeeToken,
    body: JSON.stringify({
      customer: 'Commissioned Consumer',
      phone: '+919876543299',
      applicationNumber: 'APP-COMMISSION-1',
      approvedCapacity: '5.000',
      city: 'Bhopal',
      state: 'Madhya Pradesh',
      steps: Array.from({ length: 12 }, (_, index) => ({
        startedAt: index === 0 ? new Date().toISOString() : '',
        completedAt: '',
      })),
    }),
  })
  assert.equal(application.response.status, 201)
  let commissioned
  for (let stage = 0; stage < 12; stage += 1) {
    const uploaded = await uploadApplicationStageDocument(application.body.id, stage)
    assert.equal(uploaded.response.status, 201)
    if ([2, 8].includes(stage)) {
      const approval = await request(`/api/applications/${application.body.id}/approval`, {
        method: 'POST',
        token: adminToken,
        body: JSON.stringify({ decision: 'Approved', note: 'Inspection approved' }),
      })
      assert.equal(approval.response.status, 200)
    }
    const completed = await request(`/api/applications/${application.body.id}/complete-step`, {
      method: 'POST',
      token: employeeToken,
    })
    assert.equal(completed.response.status, 200)
    if (stage === 9) commissioned = completed.body
  }
  assert.equal(commissioned.steps.length, 12)
  assert.equal(commissioned.steps[9].completedAt.length > 0, true)
  assert.ok(commissioned.commissionedInstallation)
  assert.equal(commissioned.commissionedTickets.length, 4)
  const crm = await request('/api/crm', { token: adminToken })
  const installation = crm.body.installations.find((item) => item.applicationId === application.body.id)
  assert.ok(installation)
  assert.equal(crm.body.maintenance.filter((item) => item.installationId === installation.id).length, 4)
})

test('HR login manages monthly payroll with manual deductions and private salary profiles', async () => {
  const created = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'HR Manager',
      username: 'hr.manager',
      password: 'HR_Manager_Password_123!',
      role: 'hr',
    }),
  })
  assert.equal(created.response.status, 201)
  const hrToken = (await signIn('hr.manager', 'HR_Manager_Password_123!')).token
  assert.equal((await request('/api/users', { token: hrToken })).response.status, 403)
  assert.equal((await request('/api/hr/payroll', { token: adminToken })).response.status, 403)
  assert.equal((await request('/api/hr/employees', { token: adminToken })).response.status, 403)

  const profile = await request(`/api/hr/employees/${employee.id}`, {
    method: 'PATCH',
    token: hrToken,
    body: JSON.stringify({
      department: 'Sales',
      jobTitle: 'Sales Executive',
      joiningDate: '2025-01-15',
      monthlySalary: 50000,
    }),
  })
  assert.equal(profile.response.status, 200)
  assert.equal(profile.body.monthlySalary, 50000)
  const employeeRows = await request('/api/hr/employees', { token: hrToken })
  assert.equal(employeeRows.response.status, 200)
  assert.equal(employeeRows.body.find((item) => item.id === employee.id).monthlySalary, 50000)

  const OctoberAttendance = Array.from({ length: 31 }, (_, index) => {
    const day = index + 1
    const date = `2026-10-${String(day).padStart(2, '0')}`
    return { day, date, weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay() }
  }).filter((item) => item.weekday !== 0).flatMap(({ date }) => date === '2026-10-01' ? [
    {
      id: `attendance-${date}-1`,
      userId: employee.id,
      employee: employee.name,
      date,
      checkIn: '09:00',
      checkOut: '11:00',
      checkInAt: `${date}T03:30:00.000Z`,
      checkOutAt: `${date}T05:30:00.000Z`,
      status: 'Present',
    },
    {
      id: `attendance-${date}-2`,
      userId: employee.id,
      employee: employee.name,
      date,
      checkIn: '11:30',
      checkOut: '13:30',
      checkInAt: `${date}T06:00:00.000Z`,
      checkOutAt: `${date}T08:00:00.000Z`,
      status: 'Present',
    },
  ] : [{
    id: `attendance-${date}`,
    userId: employee.id,
    employee: employee.name,
    date,
    checkIn: '09:00',
    checkOut: '17:00',
    checkInAt: `${date}T03:30:00.000Z`,
    checkOutAt: `${date}T11:30:00.000Z`,
    status: 'Present',
  }])
  const attendanceUpdate = await request('/api/crm/attendance', {
    method: 'PUT',
    token: employeeToken,
    body: JSON.stringify(OctoberAttendance),
  })
  assert.equal(attendanceUpdate.response.status, 200)

  const run = await request('/api/hr/payroll', {
    method: 'POST',
    token: hrToken,
    body: JSON.stringify({
      employeeId: employee.id,
      month: '2026-10',
      deductions: [{ label: 'Manual tax', amount: 2500 }],
    }),
  })
  assert.equal(run.response.status, 201)
  assert.equal(run.body.grossSalary, 50000)
  assert.equal(run.body.netSalary, 47500)
  assert.equal(run.body.attendanceProration, true)
  assert.equal(run.body.presentDays, 27)
  assert.equal((await request('/api/hr/payroll', { token: employeeToken })).response.status, 403)

  const paid = await request(`/api/hr/payroll/${run.body.id}/paid`, { method: 'PATCH', token: hrToken })
  assert.equal(paid.response.status, 200)
  assert.equal(paid.body.status, 'Paid')
  assert.equal((await request('/api/crm', { token: hrToken })).body.payroll.length, 0)
  assert.equal(JSON.stringify((await request('/api/crm', { token: hrToken })).body).includes('monthlySalary'), false)
})

test('holiday calendar is managed by admin, visible to employees, and reflected in crm data', async () => {
  const employeeToken = (await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')).token
  const body = JSON.stringify({ date: '2031-01-26', name: 'Republic Day' })
  assert.equal((await request('/api/holidays', { method: 'POST', token: employeeToken, body })).response.status, 403)
  assert.equal((await request('/api/holidays', { method: 'POST', token: adminToken, body: JSON.stringify({ date: 'bad', name: 'x' }) })).response.status, 400)
  const created = await request('/api/holidays', { method: 'POST', token: adminToken, body })
  assert.equal(created.response.status, 201)
  assert.equal((await request('/api/holidays', { method: 'POST', token: adminToken, body })).response.status, 409)
  const listed = await request('/api/holidays', { token: employeeToken })
  assert.equal(listed.body.some((item) => item.date === '2031-01-26'), true)
  assert.equal((await request('/api/crm', { token: employeeToken })).body.holidays.length, listed.body.length)
  assert.equal((await request(`/api/holidays/${created.body.id}`, { method: 'DELETE', token: employeeToken })).response.status, 403)
  assert.equal((await request(`/api/holidays/${created.body.id}`, { method: 'DELETE', token: adminToken })).response.status, 200)
})

test('employees save personal details to their own profile only', async () => {
  const token = (await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')).token
  const details = { presentAddress: 'A-1 Pune', temporaryAddress: 'B-2 Mumbai', fatherName: 'Ram', motherName: 'Sita', dateOfBirth: '1995-04-12' }
  const saved = await request('/api/hr/me/personal-details', { method: 'PATCH', token, body: JSON.stringify(details) })
  assert.equal(saved.response.status, 200)
  const mine = await request('/api/hr/me', { token })
  assert.equal(mine.body.motherName, 'Sita')
  assert.equal(mine.body.dateOfBirth, '1995-04-12')
  const bad = await request('/api/hr/me/personal-details', { method: 'PATCH', token, body: JSON.stringify({ ...details, dateOfBirth: '2999-01-01' }) })
  assert.equal(bad.response.status, 400)
  assert.equal((await request('/api/hr/employees/x/personal-details', { method: 'PATCH', token, body: JSON.stringify(details) })).response.status, 403)
})

test('employee contact changes require HR approval and HR account edits sync to My Profile', async () => {
  const hrToken = (await signIn('hr.manager', 'HR_Manager_Password_123!')).token
  const created = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Profile Sync Employee',
      username: 'profile.sync',
      password: 'Profile_Sync_Password_123!',
      role: 'employee',
      phone: '+919800001234',
    }),
  })
  assert.equal(created.response.status, 201)
  const token = (await signIn('profile.sync', 'Profile_Sync_Password_123!')).token
  const requestChange = await request('/api/hr/me/contact-details', {
    method: 'PATCH',
    token,
    body: JSON.stringify({ name: 'Requested Employee Name', phone: '+919800005678', contactEmail: 'contact@example.com' }),
  })
  assert.equal(requestChange.response.status, 200)
  assert.equal((await request('/api/hr/me', { token })).body.employee.name, 'Profile Sync Employee')

  const pending = (await request('/api/hr/employees', { token: hrToken })).body.find((item) => item.id === created.body.id)
  assert.equal(pending.pendingContactChange.name, 'Requested Employee Name')
  const approved = await request(`/api/hr/employees/${created.body.id}/contact-details/review`, {
    method: 'POST', token: hrToken, body: JSON.stringify({ decision: 'Approved' }),
  })
  assert.equal(approved.response.status, 200)
  assert.equal(approved.body.employee.name, 'Requested Employee Name')
  assert.equal(approved.body.employee.username, 'profile.sync')
  assert.equal(approved.body.employee.email, 'contact@example.com')
  assert.equal((await request('/api/hr/me', { token })).body.employee.name, 'Requested Employee Name')
  assert.equal((await request('/api/auth/me', { token })).body.user.name, 'Requested Employee Name')

  const hrEdit = await request(`/api/hr/employees/${created.body.id}/account`, {
    method: 'PATCH',
    token: hrToken,
    body: JSON.stringify({ name: 'HR Corrected Name', phone: '+919800009999', contactEmail: 'corrected@example.com' }),
  })
  assert.equal(hrEdit.response.status, 200)
  assert.equal(hrEdit.body.employee.name, 'HR Corrected Name')
  assert.equal(hrEdit.body.employee.phone, '+919800009999')
  assert.equal(hrEdit.body.employee.email, 'corrected@example.com')
  assert.equal(hrEdit.body.employee.username, 'profile.sync')
  assert.equal((await request('/api/hr/me', { token })).body.employee.name, 'HR Corrected Name')

  const rejectedRequest = await request('/api/hr/me/contact-details', {
    method: 'PATCH',
    token,
    body: JSON.stringify({ name: 'Rejected Name', phone: '', contactEmail: '' }),
  })
  assert.equal(rejectedRequest.response.status, 200)
  const rejected = await request(`/api/hr/employees/${created.body.id}/contact-details/review`, {
    method: 'POST', token: hrToken, body: JSON.stringify({ decision: 'Rejected' }),
  })
  assert.equal(rejected.response.status, 200)
  assert.equal(rejected.body.employee.name, 'HR Corrected Name')
  assert.equal((await request('/api/hr/me', { token })).body.pendingContactChange, undefined)
  assert.equal((await request(`/api/hr/employees/${created.body.id}/account`, {
    method: 'PATCH', token,
    body: JSON.stringify({ name: 'Employee Cannot Directly Edit', phone: '', contactEmail: '' }),
  })).response.status, 403)
})

test('Cloudinary visit photo uploads are authenticated and visit records are role-scoped', async () => {
  const token = (await signIn('DYNAMIC.EMPLOYEE@EXAMPLE.COM', 'Employee_Password_123!')).token
  const oldCredentials = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    url: process.env.CLOUDINARY_URL,
  }
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
  process.env.CLOUDINARY_API_KEY = 'test-key'
  process.env.CLOUDINARY_API_SECRET = 'test-secret'
  process.env.CLOUDINARY_URL = ''
  const originalFetch = global.fetch
  let uploadForm
  global.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.cloudinary.com/')) {
      uploadForm = options.body
      return new Response(JSON.stringify({
        secure_url: 'https://res.cloudinary.com/test-cloud/image/upload/v1/test/site.webp',
        public_id: 'test/site',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return originalFetch(url, options)
  }
  try {
    const uploaded = await request('/api/uploads', {
      method: 'POST',
      token,
      body: JSON.stringify({ context: 'site-visit', image: 'data:image/png;base64,iVBORw0KGgo=' }),
    })
    assert.equal(uploaded.response.status, 201)
    assert.ok(uploadForm instanceof FormData)
    const visit = await request('/api/visits', {
      method: 'POST',
      token,
      body: JSON.stringify({
        kind: 'Site visit',
        customer: 'Visit Customer',
        note: 'Roof measurements completed',
        photoUrl: uploaded.body.url,
      }),
    })
    assert.equal(visit.response.status, 201)
    const ownVisits = await request('/api/visits', { token })
    assert.ok(ownVisits.body.some((item) => item.id === visit.body.id))
    const forbidden = await request('/api/visits', {
      method: 'POST',
      token: technicianToken,
      body: JSON.stringify({ kind: 'Sales visit', customer: 'Not allowed', photoUrl: uploaded.body.url }),
    })
    assert.equal(forbidden.response.status, 403)
  } finally {
    global.fetch = originalFetch
    for (const [key, value] of Object.entries({
      CLOUDINARY_CLOUD_NAME: oldCredentials.cloudName,
      CLOUDINARY_API_KEY: oldCredentials.apiKey,
      CLOUDINARY_API_SECRET: oldCredentials.apiSecret,
      CLOUDINARY_URL: oldCredentials.url,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('employees manage their own encrypted bank details and private HR documents', async () => {
  const employeeToken = (await signIn('dynamic.employee@example.com', 'Employee_Password_123!')).token
  const createdHr = await request('/api/users', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      name: 'Private Records HR',
      username: 'private.records.hr',
      password: 'Private_Records_HR_123!',
      role: 'hr',
    }),
  })
  assert.equal(createdHr.response.status, 201)
  const hrToken = (await signIn('private.records.hr', 'Private_Records_HR_123!')).token
  const bankDetails = {
    accountHolder: 'Dynamic Employee',
    bankName: 'Example Bank',
    accountNumber: '123456789012',
    ifsc: 'ABCD0123456',
  }
  const bankUpdate = await request('/api/hr/me/bank-details', {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify(bankDetails),
  })
  assert.equal(bankUpdate.response.status, 200)
  assert.equal(bankUpdate.body.bankDetails.accountNumber, bankDetails.accountNumber)
  assert.equal((await request('/api/hr/me/bank-details', {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify({ ...bankDetails, ifsc: 'INVALID' }),
  })).response.status, 400)
  const encryptionKey = process.env.HR_DATA_ENCRYPTION_KEY
  delete process.env.HR_DATA_ENCRYPTION_KEY
  const missingKey = await request('/api/hr/me/bank-details', {
    method: 'PATCH',
    token: employeeToken,
    body: JSON.stringify(bankDetails),
  })
  process.env.HR_DATA_ENCRYPTION_KEY = encryptionKey
  assert.equal(missingKey.response.status, 503)

  const credentials = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
    url: process.env.CLOUDINARY_URL,
  }
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
  process.env.CLOUDINARY_API_KEY = 'test-key'
  process.env.CLOUDINARY_API_SECRET = 'test-secret'
  process.env.CLOUDINARY_URL = ''
  const originalFetch = global.fetch
  let uploadedForm
  global.fetch = async (url, options) => {
    const target = String(url)
    if (target.startsWith('https://api.cloudinary.com/v1_1/test-cloud/raw/upload')) {
      uploadedForm = options.body
      return new Response(JSON.stringify({
        public_id: 'zxsolarcrm/employee-documents/employee/document-1',
        format: 'pdf',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (target.startsWith('https://api.cloudinary.com/v1_1/test-cloud/raw/download')) {
      return new Response('%PDF-1.7 private employee document', { status: 200 })
    }
    return originalFetch(url, options)
  }
  try {
    const uploaded = await request('/api/hr/me/documents', {
      method: 'POST',
      token: employeeToken,
      body: JSON.stringify({
        category: 'Aadhaar Card',
        document: `data:application/pdf;base64,${Buffer.from('%PDF-1.7 employee identity').toString('base64')}`,
      }),
    })
    assert.equal(uploaded.response.status, 201)
    assert.ok(uploadedForm instanceof FormData)
    assert.equal(uploadedForm.get('type'), 'authenticated')
    assert.equal(uploaded.body.publicId, undefined)

    const ownProfile = await request('/api/hr/me', { token: employeeToken })
    assert.equal(ownProfile.response.status, 200)
    assert.equal(ownProfile.body.bankDetails.accountNumber, bankDetails.accountNumber)
    assert.equal(ownProfile.body.documents[0].category, 'Aadhaar Card')

    const privateDownload = await request(`/api/hr/me/documents/${uploaded.body.id}/download`, { token: employeeToken })
    assert.equal(privateDownload.response.status, 200)
    assert.match(privateDownload.response.headers.get('content-type'), /application\/pdf/)

    const hrEmployees = await request('/api/hr/employees', { token: hrToken })
    assert.equal(hrEmployees.response.status, 200)
    const hrEmployee = hrEmployees.body.find((item) => item.id === employee.id)
    assert.equal(hrEmployee.bankDetails.accountNumber, bankDetails.accountNumber)
    assert.equal(hrEmployee.documents[0].category, 'Aadhaar Card')
    const hrDownload = await request(`/api/hr/employees/${employee.id}/documents/${uploaded.body.id}/download`, { token: hrToken })
    assert.equal(hrDownload.response.status, 200)
    assert.equal((await request('/api/hr/employees', { token: employeeToken })).response.status, 403)

    const stored = fs.readFileSync(process.env.CRM_DATA_FILE, 'utf8')
    assert.equal(stored.includes(bankDetails.accountNumber), false)
    assert.equal(stored.includes('bankDetailsEncrypted'), true)
  } finally {
    global.fetch = originalFetch
    for (const [key, value] of Object.entries({
      CLOUDINARY_CLOUD_NAME: credentials.cloudName,
      CLOUDINARY_API_KEY: credentials.apiKey,
      CLOUDINARY_API_SECRET: credentials.apiSecret,
      CLOUDINARY_URL: credentials.url,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
