const fs = require('node:fs/promises')
const path = require('node:path')
const config = require('../config')
const CrmState = require('./CrmState')
const { migrateCustomers } = require('../services/customerService')
const { migrateApplications } = require('../config/applicationWorkflow')

const dataFile = config.crmDataFile
let pendingWrite = Promise.resolve()
const emptyData = {
  leads: [],
  attendance: [],
  installations: [],
  maintenance: [],
  applications: [],
  customers: [],
  hrProfiles: [],
  payroll: [],
  visits: [],
}

async function findAll() {
  if (!config.localTestStorage) {
    const state = await CrmState.findById('primary').lean()
    if (!state) throw new Error('CRM database has not been initialized.')
    const data = state.data
    if (!Array.isArray(data.customers)) data.customers = []
    for (const [key, value] of Object.entries(emptyData)) {
      if (!Array.isArray(data[key])) data[key] = value
    }
    return data
  }
  return JSON.parse(await fs.readFile(dataFile, 'utf8'))
}

async function persist(data) {
  const temporaryFile = `${dataFile}.tmp`
  await fs.writeFile(temporaryFile, JSON.stringify(data, null, 2))
  await fs.rename(temporaryFile, dataFile)
}

function enqueue(work) {
  pendingWrite = pendingWrite.catch(() => {}).then(work)
  return pendingWrite
}

async function replaceAll(data) {
  if (!config.localTestStorage) {
    await CrmState.findOneAndUpdate(
      { _id: 'primary' },
      { $set: { data }, $inc: { revision: 1 } },
      { upsert: true, new: true, runValidators: true },
    )
    return
  }
  return enqueue(() => persist(data))
}

async function update(mutator) {
  if (!config.localTestStorage) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const state = await CrmState.findById('primary').lean()
      if (!state) throw new Error('CRM database has not been initialized.')
      const data = state.data
      const result = await mutator(data)
      const updated = await CrmState.findOneAndUpdate(
        { _id: 'primary', revision: state.revision },
        { $set: { data }, $inc: { revision: 1 } },
        { new: true, runValidators: true },
      ).lean()
      if (updated) return result
    }
    const error = new Error('CRM data changed concurrently. Please retry the request.')
    error.status = 409
    throw error
  }
  let result
  await enqueue(async () => {
    const data = await findAll()
    result = await mutator(data)
    await persist(data)
  })
  return result
}

async function initialize() {
  if (!config.localTestStorage) {
    await CrmState.updateOne(
      { _id: 'primary' },
      { $setOnInsert: { data: emptyData, revision: 0 } },
      { upsert: true, runValidators: true },
    )
    await update((data) => {
      migrateCustomers(data)
      migrateApplications(data)
    })
    return
  }
  await fs.mkdir(path.dirname(dataFile), { recursive: true })
  try {
    await fs.access(dataFile)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await replaceAll(emptyData)
  }
  const data = await findAll()
  let changed = false
  for (const [key, value] of Object.entries(emptyData)) {
    if (!Array.isArray(data[key])) {
      data[key] = value
      changed = true
    }
  }
  const original = JSON.stringify(data)
  migrateCustomers(data)
  migrateApplications(data)
  changed ||= JSON.stringify(data) !== original
  if (changed) await replaceAll(data)
}

module.exports = { findAll, initialize, replaceAll, update }
