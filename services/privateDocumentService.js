const crypto = require('node:crypto')
const { privateDownloadUrl, signedUploadParameters } = require('./cloudinaryService')

const mimeTypes = {
  'application/pdf': { extension: 'pdf', signature: Buffer.from('%PDF-') },
  'image/jpeg': { extension: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) },
  'image/png': { extension: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
}
const MAX_BYTES = 7 * 1024 * 1024

function badRequest(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

// Validates a PDF/JPEG/PNG data URL and stores it as a private (authenticated) Cloudinary asset.
async function uploadPrivateFile(dataUrl, folder) {
  const match = typeof dataUrl === 'string' &&
    dataUrl.match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) throw badRequest('Upload a PDF, JPEG, or PNG document.')
  const [, mimeType, encoded] = match
  const buffer = Buffer.from(encoded, 'base64')
  const type = mimeTypes[mimeType]
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== encoded ||
      buffer.length < type.signature.length || !buffer.subarray(0, type.signature.length).equals(type.signature)) {
    throw badRequest('Document must be a valid PDF, JPEG, or PNG no larger than 7 MB.')
  }
  const timestamp = Math.floor(Date.now() / 1000)
  const publicId = crypto.randomUUID()
  const parameters = { folder, public_id: publicId, timestamp, type: 'authenticated' }
  const { credentials, signature } = signedUploadParameters(parameters)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), `document.${type.extension}`)
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
  if (!response.ok || typeof result.public_id !== 'string') throw badRequest('Cloudinary could not store this document.', 502)
  return { mimeType, publicId: result.public_id, format: result.format || type.extension, size: buffer.length }
}

module.exports = { privateDownloadUrl, uploadPrivateFile }
