const { after, before, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const testDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-solar-crm-test-'))
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

const { app, initializeData } = require('./server')
let server
let baseUrl
let adminToken
let technicianToken
let employee
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
  assert.equal(crm.body.users.length, 1)
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
  assert.equal(login.user.id, employee.id)
  assert.equal(login.user.role, 'employee')

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
  assert.deepEqual(employeeCrm.body.users.map((user) => user.id), [employee.id])
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
          { name: 'first_name', values: ['Meta Ads'] },
          { name: 'last_name', values: ['Customer'] },
          { name: 'phone_number', values: ['+919876500001'] },
          { name: 'email', values: ['meta@example.com'] },
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
  assert.ok(crm.body.leads.some((lead) => lead.name === 'Meta Ads Customer' && lead.source === 'Meta Lead Ads'))
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
    token: adminToken,
    body: JSON.stringify(application),
  })
  assert.equal(created.response.status, 201)
  const completed = await request(`/api/applications/${created.body.id}/complete-step`, {
    method: 'POST',
    token: adminToken,
  })
  assert.equal(completed.response.status, 200)
  assert.ok(completed.body.steps[0].completedAt)
  assert.ok(completed.body.steps[1].startedAt)

  const crm = await request('/api/crm', { token: adminToken })
  assert.equal(crm.body.applications[0].applicationNumber, 'APP-TEST-1')
})

test('new installation creates persistent quarterly jobs for created technician', async () => {
  const created = await request('/api/installations', {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({
      customer: 'Dynamic Solar Customer',
      phone: '+919876543210',
      address: 'Test address',
      installDate: '2026-01-15',
    }),
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.maintenance.length, 4)
  assert.ok(created.body.maintenance.every((job) => job.workerId === technician.id))

  const technicianCrm = await request('/api/crm', { token: technicianToken })
  assert.equal(technicianCrm.body.maintenance.length, 4)
  assert.equal(technicianCrm.body.installations[0].customer, 'Dynamic Solar Customer')
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
  try {
    otpResponse = await request(`/api/maintenance/${encodeURIComponent((await request('/api/crm', { token: technicianToken })).body.maintenance[0].id)}/otp`, {
      method: 'POST',
      token: technicianToken,
    })
  } finally {
    global.fetch = originalFetch
  }
  assert.equal(otpResponse.response.status, 200)
  assert.equal(otpResponse.body.otp, undefined)
  assert.match(sentOtp, /^\d{4}$/)

  const jobs = (await request('/api/crm', { token: technicianToken })).body.maintenance
  const job = jobs[0]
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
