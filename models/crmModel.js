const fs = require('node:fs/promises')
const path = require('node:path')
const mongoose = require('mongoose')
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

const resourceKeys = Object.keys(emptyData)
const resourceCollection = (key) => mongoose.connection.collection(`crm_${key}`)
const metadataCollection = () => mongoose.connection.collection('crm_metadata')

async function loadResourceData(session) {
  const rows = await Promise.all(resourceKeys.map((key) =>
    resourceCollection(key).findOne({ _id: 'primary' }, { session })))
  return Object.fromEntries(resourceKeys.map((key, index) => [
    key,
    Array.isArray(rows[index]?.items) ? rows[index].items : [],
  ]))
}

async function initializeResourceCollections() {
  const metadata = await metadataCollection().findOne({ _id: 'primary' })
  if (metadata?.resourcesInitialized) return metadata
  const legacy = await CrmState.findById('primary').lean()
  const data = legacy?.data || emptyData
  await Promise.all(resourceKeys.map((key) =>
    resourceCollection(key).replaceOne(
      { _id: 'primary' },
      { _id: 'primary', items: Array.isArray(data[key]) ? data[key] : [] },
      { upsert: true },
    )))
  await metadataCollection().updateOne(
    { _id: 'primary' },
    { $set: { resourcesInitialized: true, revision: Number(legacy?.revision || 0) } },
    { upsert: true },
  )
  return metadataCollection().findOne({ _id: 'primary' })
}

async function findAll() {
  if (!config.localTestStorage) {
    await initializeResourceCollections()
    const data = await loadResourceData()
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
    await initializeResourceCollections()
    await Promise.all(resourceKeys.map((key) =>
      resourceCollection(key).replaceOne(
        { _id: 'primary' },
        { _id: 'primary', items: data[key] || [] },
        { upsert: true },
      )))
    await metadataCollection().updateOne({ _id: 'primary' }, { $inc: { revision: 1 } })
    return
  }
  return enqueue(() => persist(data))
}

async function update(mutator) {
  if (!config.localTestStorage) {
    await initializeResourceCollections()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const metadata = await metadataCollection().findOne({ _id: 'primary' })
      const data = await loadResourceData()
      const result = await mutator(data)
      const updated = await metadataCollection().findOneAndUpdate(
        { _id: 'primary', revision: metadata.revision },
        { $inc: { revision: 1 } },
        { returnDocument: 'after', includeResultMetadata: true },
      )
      if (updated?.value) {
        await Promise.all(resourceKeys.map((key) =>
          resourceCollection(key).replaceOne(
            { _id: 'primary' },
            { _id: 'primary', items: data[key] || [] },
            { upsert: true },
          )))
        return result
      }
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
