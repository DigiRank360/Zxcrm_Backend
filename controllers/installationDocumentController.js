const crypto = require('node:crypto')
const InstallationDocument = require('../models/InstallationDocument')
const crmModel = require('../models/crmModel')
const { employeeOwnsInstallation } = require('../services/accessService')
const { privateDownloadUrl, signedUploadParameters } = require('../services/cloudinaryService')

const MAX_DOCUMENT_BYTES = 7 * 1024 * 1024
const types = {
  'application/pdf': { extension: 'pdf', signature: Buffer.from('%PDF-') },
  'image/jpeg': { extension: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) },
  'image/png': { extension: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
}

function installationFor(data, id) {
  return (data.installations || []).find((installation) => installation.id === id)
}

function visibleTo(document, user) {
  return user.role === 'admin' || document.employeeId === user.id
}

function publicDocument(document) {
  const value = document.toObject ? document.toObject() : document
  const { publicId, format, ...safe } = value
  return safe
}

async function upload(req, res, next) {
  const { document, fileName = 'valuation-document' } = req.body || {}
  if (typeof document !== 'string' || typeof fileName !== 'string' || fileName.length > 180) {
    return res.status(400).json({ error: 'Provide a valuation document and file name.' })
  }
  try {
    const data = await crmModel.findAll()
    const installation = installationFor(data, req.params.installationId)
    if (!installation) return res.status(404).json({ error: 'Installation not found.' })
    if (req.user.role !== 'employee' || !employeeOwnsInstallation(data, installation, req.user.id)) {
      return res.status(403).json({ error: 'Only the assigned employee can upload valuation documents.' })
    }
    const match = document.match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/)
    if (!match) return res.status(400).json({ error: 'Upload a PDF, JPEG, or PNG valuation document.' })
    const [, mimeType, encoded] = match
    const buffer = Buffer.from(encoded, 'base64')
    const type = types[mimeType]
    if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES ||
        buffer.toString('base64') !== encoded ||
        buffer.length < type.signature.length ||
        !buffer.subarray(0, type.signature.length).equals(type.signature)) {
      return res.status(400).json({ error: 'Document must be a valid PDF, JPEG, or PNG no larger than 7 MB.' })
    }
    const timestamp = Math.floor(Date.now() / 1000)
    const publicId = crypto.randomUUID()
    const folder = `zxsolarcrm/installation-valuations/${installation.id}/${req.user.id}`
    const parameters = { folder, public_id: publicId, timestamp, type: 'authenticated' }
    const { credentials, signature } = signedUploadParameters(parameters)
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), `${publicId}.${type.extension}`)
    form.append('api_key', credentials.api_key)
    form.append('timestamp', String(timestamp))
    form.append('folder', folder)
    form.append('public_id', publicId)
    form.append('type', 'authenticated')
    form.append('signature', signature)
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(credentials.cloud_name)}/raw/upload`, {
      method: 'POST',
      body: form,
    })
    const result = await response.json()
    if (!response.ok || typeof result.public_id !== 'string') {
      return res.status(502).json({ error: 'Cloudinary could not store this valuation document.' })
    }
    const created = await InstallationDocument.create({
      id: crypto.randomUUID(),
      installationId: installation.id,
      employeeId: req.user.id,
      fileName: fileName.trim() || `valuation.${type.extension}`,
      mimeType,
      publicId: result.public_id,
      format: result.format || type.extension,
      status: 'Submitted',
      reviews: [{ status: 'Submitted', note: 'Document uploaded.', userId: req.user.id, userName: req.user.name }],
    })
    res.status(201).json(publicDocument(created))
  } catch (error) {
    next(error)
  }
}

async function list(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const installation = installationFor(data, req.params.installationId)
    if (!installation) return res.status(404).json({ error: 'Installation not found.' })
    if (req.user.role !== 'admin' && !employeeOwnsInstallation(data, installation, req.user.id)) {
      return res.status(404).json({ error: 'Installation not found.' })
    }
    const documents = await InstallationDocument.find({ installationId: installation.id }).sort({ uploadedAt: -1 }).lean()
    res.json(documents.filter((document) => visibleTo(document, req.user)).map(publicDocument))
  } catch (error) {
    next(error)
  }
}

async function download(req, res, next) {
  try {
    const document = await InstallationDocument.findOne({ id: req.params.documentId }).lean()
    if (!document || document.installationId !== req.params.installationId || !visibleTo(document, req.user)) {
      return res.status(404).json({ error: 'Document not found.' })
    }
    const data = await crmModel.findAll()
    const installation = installationFor(data, document.installationId)
    if (!installation || (req.user.role !== 'admin' && !employeeOwnsInstallation(data, installation, req.user.id))) {
      return res.status(404).json({ error: 'Document not found.' })
    }
    res.json({ url: privateDownloadUrl(document) })
  } catch (error) {
    next(error)
  }
}

async function review(req, res, next) {
  const { status, note = '' } = req.body || {}
  if (!['Verified', 'Approved', 'Rejected'].includes(status) || typeof note !== 'string' || note.length > 1000 ||
      (status === 'Rejected' && !note.trim())) {
    return res.status(400).json({ error: 'Choose Verified, Approved, or Rejected and provide a valid note.' })
  }
  try {
    const document = await InstallationDocument.findOne({ id: req.params.documentId })
    if (!document) return res.status(404).json({ error: 'Document not found.' })
    if (document.installationId !== req.params.installationId) return res.status(404).json({ error: 'Document not found.' })
    if (status === 'Approved' && document.status !== 'Verified') {
      return res.status(409).json({ error: 'Verify the document before approving it.' })
    }
    if (document.status === 'Approved') return res.status(409).json({ error: 'Approved documents cannot be changed.' })
    document.status = status
    document.reviews.push({ status, note: note.trim(), userId: req.user.id, userName: req.user.name })
    await document.save()
    res.json(publicDocument(document))
  } catch (error) {
    next(error)
  }
}

module.exports = { download, list, review, upload }
