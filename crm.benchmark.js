const crypto = require('node:crypto')
const { performance } = require('node:perf_hooks')
const mongoose = require('mongoose')

async function main() {
  const uri = new URL(process.env.CRM_BENCHMARK_MONGODB_URI || '')
  if (uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1' || uri.username || uri.password) {
    throw new Error('CRM_BENCHMARK_MONGODB_URI must be an unauthenticated MongoDB instance on 127.0.0.1.')
  }
  uri.pathname = `/crm_benchmark_${crypto.randomUUID().replace(/-/g, '')}`
  process.env.NODE_ENV = 'benchmark'
  process.env.MONGODB_URI = uri.toString()
  process.env.ADMIN_USERNAME = 'benchmark-admin'
  process.env.ADMIN_PASSWORD = 'Benchmark_Test_Password_123!'
  process.env.ADMIN_NAME = 'Benchmark Admin'

  const connect = mongoose.connect.bind(mongoose)
  mongoose.connect = (address, options) => connect(address, { ...options, monitorCommands: true })
  const { app, initializeData } = require('./server')
  const crm = require('./models/crmModel')
  let server
  try {
    await mongoose.connect(process.env.MONGODB_URI)
    const hello = await mongoose.connection.db.admin().command({ hello: 1 })
    if (!hello.setName || !hello.isWritablePrimary) throw new Error('An isolated local replica-set primary is required.')
    await initializeData()
    const data = await crm.findAll()
    data.leads = Array.from({ length: 100 }, (_, index) => ({
      id: `lead-${index}`,
      name: `Lead ${index}`,
      phone: `+1555000${String(index).padStart(4, '0')}`,
      status: 'New',
      agentId: null,
      notes: '',
      date: '2026-01-01',
    }))
    await crm.replaceAll(data)
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
    })
    if (!login.ok) throw new Error(`Benchmark login failed: ${login.status}`)
    const { token } = await login.json()
    const commands = {}
    let resourceReads = 0
    let arrayRewrites = 0
    const listener = (event) => {
      commands[event.commandName] = (commands[event.commandName] || 0) + 1
      const collection = event.command[event.commandName]
      if (event.commandName === 'find' && /^crm_(?!metadata$)/.test(collection)) resourceReads += 1
      if (event.commandName === 'update' && /^crm_(?!metadata$)/.test(collection)) {
        arrayRewrites += event.command.updates.filter((item) =>
          item.u?.$set?.items || (item.u && !Object.keys(item.u).some((key) => key.startsWith('$')))).length
      }
    }
    mongoose.connection.getClient().on('commandStarted', listener)
    const updateLead = async (id, value) => {
      const start = performance.now()
      const response = await fetch(`${base}/api/leads/lead-${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: value }),
      })
      await response.arrayBuffer()
      return { status: response.status, duration: performance.now() - start }
    }
    const cpu = process.cpuUsage()
    const started = performance.now()
    const sequential = []
    for (let index = 0; index < 30; index += 1) sequential.push(await updateLead(index, `sequential-${index}`))
    const concurrent = await Promise.all(Array.from({ length: 10 }, (_, index) => updateLead(index + 30, `concurrent-${index}`)))
    const elapsedMs = performance.now() - started
    const cpuUsage = process.cpuUsage(cpu)
    mongoose.connection.getClient().off('commandStarted', listener)
    const sorted = sequential.map((item) => item.duration).sort((a, b) => a - b)
    const statuses = (results) => results.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1
      return counts
    }, {})
    console.log(JSON.stringify({
      sequentialStatuses: statuses(sequential),
      sequentialP50Ms: sorted[Math.floor(sorted.length * 0.5)],
      sequentialP95Ms: sorted[Math.floor(sorted.length * 0.95)],
      concurrentStatuses: statuses(concurrent),
      elapsedMs,
      cpuMs: (cpuUsage.user + cpuUsage.system) / 1000,
      rssBytes: process.memoryUsage().rss,
      resourceReads,
      arrayRewrites,
      commands,
    }, null, 2))
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error(error.name, error.message)
  process.exitCode = 1
})
