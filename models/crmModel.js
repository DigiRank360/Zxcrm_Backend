const fs = require('node:fs/promises')
const path = require('node:path')
const mongoose = require('mongoose')
const config = require('../config')
const CrmState = require('./CrmState')
const { migrateCustomers } = require('../services/customerService')
const { migrateApplications } = require('../config/applicationWorkflow')

const dataFile = config.crmDataFile
let pendingWrite = Promise.resolve()
let initialization
let transactionSupport
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
  holidays: [],
  leaveRequests: [],
}

const resourceKeys = Object.keys(emptyData)
const resourceCollection = (key) => mongoose.connection.collection(`crm_${key}`)
const metadataCollection = () => mongoose.connection.collection('crm_metadata')
const delay = (attempt) => new Promise((resolve) =>
  setTimeout(resolve, Math.min(200, 10 * (2 ** attempt)) + Math.random() * 20))

function validateKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length ||
      keys.some((key) => !resourceKeys.includes(key))) {
    throw new TypeError('Invalid CRM resource keys.')
  }
}

function conflictError(keys) {
  const error = new Error('CRM data changed concurrently. Please retry the request.')
  error.status = 409
  error.crmConflict = true
  error.resources = keys
  return error
}

async function timed(operation, key, work) {
  const enabled = process.env.CRM_PERF_LOG === '1' || process.env.NODE_ENV === 'development'
  if (!enabled) return work()
  const started = process.hrtime.bigint()
  try {
    return await work()
  } finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6
    if (durationMs >= 250) {
      console.warn(JSON.stringify({ event: 'slow_crm_database_operation', operation, resource: key, durationMs: Math.round(durationMs) }))
    }
  }
}

async function ensureTransactionSupport() {
  if (!transactionSupport) {
    transactionSupport = (async () => {
      const hello = await mongoose.connection.db.admin().command({ hello: 1 })
      if (hello.logicalSessionTimeoutMinutes == null ||
          !(hello.setName || hello.msg === 'isdbgrid') ||
          hello.maxWireVersion < (hello.msg === 'isdbgrid' ? 8 : 7)) {
        const error = new Error('MongoDB transactions are required for linked CRM resources.')
        error.status = 503
        throw error
      }
    })().catch((error) => {
      transactionSupport = undefined
      throw error
    })
  }
  return transactionSupport
}

async function transaction(work, { retrySafe = false, resources } = {}) {
  await ensureTransactionSupport()
  for (let attempt = 0; attempt < (retrySafe ? 5 : 1); attempt += 1) {
    const session = await mongoose.startSession()
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      const result = await work(session)
      for (let commitAttempt = 0; ; commitAttempt += 1) {
        try {
          await session.commitTransaction()
          return result
        } catch (error) {
          if (!error.hasErrorLabel?.('UnknownTransactionCommitResult')) throw error
          if (commitAttempt >= 4) {
            const uncertain = new Error('The database could not confirm the transaction outcome.')
            uncertain.status = 503
            uncertain.cause = error
            throw uncertain
          }
          await delay(commitAttempt)
        }
      }
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction()
      const conflict = error.crmConflict || error.code === 112
      const transient = conflict || error.hasErrorLabel?.('TransientTransactionError')
      if (!transient) throw error
      if (!retrySafe || attempt === 4) {
        if (conflict) throw conflictError(error.resources || resources)
        throw error
      }
      await delay(attempt)
    } finally {
      await session.endSession()
    }
  }
}

async function initializeResourceCollections() {
  if (!initialization) {
    initialization = (async () => {
      const metadata = await metadataCollection().findOne({ _id: 'primary' })
      if (metadata?.resourcesInitialized) return
      await transaction(async (session) => {
        const current = await metadataCollection().findOne({ _id: 'primary' }, { session })
        if (current?.resourcesInitialized) return
        const legacy = await CrmState.findById('primary').session(session).lean()
        const data = legacy?.data || emptyData
        for (const key of resourceKeys) {
          await resourceCollection(key).updateOne(
            { _id: 'primary' },
            { $setOnInsert: { items: Array.isArray(data[key]) ? data[key] : [], revision: 0 } },
            { upsert: true, session },
          )
        }
        await metadataCollection().updateOne(
          { _id: 'primary' },
          { $set: { resourcesInitialized: true }, $setOnInsert: { revision: Number(legacy?.revision || 0) } },
          { upsert: true, session },
        )
      }, { retrySafe: true })
    })().catch((error) => {
      initialization = undefined
      throw error
    })
  }
  return initialization
}

async function findResources(keys) {
  validateKeys(keys)
  if (config.localTestStorage) {
    const data = await findAll()
    return Object.fromEntries(keys.map((key) => [key, data[key]]))
  }
  await initializeResourceCollections()
  const read = async (session) => {
    const data = {}
    for (const key of keys) {
      const row = await timed('find', key, () =>
        resourceCollection(key).findOne({ _id: 'primary' }, session ? { session } : {}))
      if (!row || !Array.isArray(row.items)) throw new Error(`CRM resource ${key} is missing or invalid.`)
      data[key] = row.items
    }
    return data
  }
  return keys.length > 1 ? transaction(read, { retrySafe: true }) : read()
}

async function findResource(key) {
  return (await findResources([key]))[key]
}

async function findProjectedResources(projections) {
  const keys = Object.keys(projections)
  validateKeys(keys)
  for (const fields of Object.values(projections)) {
    if (!Array.isArray(fields) || !fields.length || fields.some((field) => !/^[A-Za-z][A-Za-z0-9]*$/.test(field))) {
      throw new TypeError('Invalid CRM projection fields.')
    }
  }
  if (config.localTestStorage) {
    const data = await findResources(keys)
    return Object.fromEntries(keys.map((key) => [
      key,
      data[key].map((item) => Object.fromEntries(
        projections[key].filter((field) => Object.hasOwn(item, field)).map((field) => [field, item[field]]),
      )),
    ]))
  }
  await initializeResourceCollections()
  const read = async (session) => {
    const data = {}
    for (const key of keys) {
      const fields = Object.fromEntries(projections[key].map((field) => [field, `$$item.${field}`]))
      const [row] = await timed('aggregate', key, () => resourceCollection(key).aggregate([
        { $match: { _id: 'primary' } },
        { $project: { items: { $map: { input: '$items', as: 'item', in: fields } } } },
      ], session ? { session } : {}).toArray())
      if (!row || !Array.isArray(row.items)) throw new Error(`CRM resource ${key} is missing or invalid.`)
      data[key] = row.items
    }
    return data
  }
  return keys.length > 1 ? transaction(read, { retrySafe: true }) : read()
}

async function findAll() {
  if (!config.localTestStorage) return findResources(resourceKeys)
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

async function updateResources(keys, mutator, options = {}) {
  validateKeys(keys)
  if (config.localTestStorage) {
    return enqueue(async () => {
      const current = await findAll()
      const data = Object.fromEntries(keys.map((key) => [key, current[key]]))
      const before = JSON.stringify(data)
      const result = await mutator(data)
      if (JSON.stringify(data) !== before) {
        for (const key of keys) current[key] = data[key]
        await persist(current)
      }
      return result
    })
  }
  await initializeResourceCollections()
  const mutate = async (session) => {
    const rows = []
    for (const key of keys) {
      const row = await timed('find', key, () =>
        resourceCollection(key).findOne({ _id: 'primary' }, session ? { session } : {}))
      if (!row || !Array.isArray(row.items)) throw new Error(`CRM resource ${key} is missing or invalid.`)
      rows.push(row)
    }
    const data = Object.fromEntries(keys.map((key, index) => [key, rows[index].items]))
    const snapshot = (key) => mongoose.mongo.BSON.serialize({ items: data[key] }, { ignoreUndefined: false })
    const before = keys.map(snapshot)
    const result = await mutator(data)
    if (keys.some((key) => !Array.isArray(data[key]))) throw new TypeError('CRM resources must be arrays.')
    const changed = keys.map((key, index) => !snapshot(key).equals(before[index]))
    if (!changed.some(Boolean)) return result
    for (const [index, key] of keys.entries()) {
      const revision = rows[index].revision
      const filter = { _id: 'primary', revision: revision === undefined ? { $exists: false } : revision }
      const write = await timed('update', key, () => resourceCollection(key).updateOne(
        filter,
        { ...(changed[index] ? { $set: { items: data[key] } } : {}), $inc: { revision: 1 } },
        session ? { session } : { writeConcern: { w: 'majority' } },
      ))
      if (write.matchedCount !== 1) throw conflictError(keys)
    }
    return result
  }
  if (keys.length > 1) return transaction(mutate, { ...options, resources: keys })
  for (let attempt = 0; attempt < (options.retrySafe ? 5 : 1); attempt += 1) {
    try {
      return await mutate()
    } catch (error) {
      if (!error.crmConflict || !options.retrySafe || attempt === 4) throw error
      await delay(attempt)
    }
  }
}

async function updateResource(key, mutator, options) {
  return updateResources([key], (data) => mutator(data), options)
}

async function update(mutator) {
  return updateResources(resourceKeys, mutator)
}

async function replaceAll(data) {
  return updateResources(resourceKeys, (current) => {
    for (const key of resourceKeys) current[key] = data[key] || []
  })
}

async function initialize() {
  if (!config.localTestStorage) {
    await ensureTransactionSupport()
    await CrmState.updateOne(
      { _id: 'primary' },
      { $setOnInsert: { data: emptyData, revision: 0 } },
      { upsert: true, runValidators: true },
    )
    await initializeResourceCollections()
    await updateResources(['leads', 'attendance', 'installations', 'maintenance', 'applications', 'customers'], (data) => {
      migrateCustomers(data)
      migrateApplications(data)
    }, { retrySafe: true })
    return
  }
  await fs.mkdir(path.dirname(dataFile), { recursive: true })
  try {
    await fs.access(dataFile)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await enqueue(() => persist(emptyData))
  }
  await updateResources(resourceKeys, (data) => {
    for (const [key, value] of Object.entries(emptyData)) {
      if (!Array.isArray(data[key])) data[key] = value
    }
    migrateCustomers(data)
    migrateApplications(data)
  })
}

module.exports = { findAll, findProjectedResources, findResource, findResources, initialize, replaceAll, update, updateResource, updateResources }
