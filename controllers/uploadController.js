const crypto = require('node:crypto')

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const allowedContexts = new Set(['attendance', 'site-visit', 'sales-visit'])
const mimeExtensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

function cloudinaryCredentials() {
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    return {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      apiSecret: process.env.CLOUDINARY_API_SECRET,
    }
  }
  if (process.env.CLOUDINARY_URL) {
    try {
      const url = new URL(process.env.CLOUDINARY_URL)
      if (url.protocol === 'cloudinary:' && url.username && url.password && url.hostname) {
        return { cloudName: url.hostname, apiKey: url.username, apiSecret: url.password }
      }
    } catch {
      return null
    }
  }
  return null
}

async function create(req, res, next) {
  const { image, context } = req.body || {}
  if (typeof image !== 'string' || !allowedContexts.has(context)) {
    return res.status(400).json({ error: 'Provide a supported image and upload context.' })
  }
  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) return res.status(400).json({ error: 'Upload a JPEG, PNG, or WebP image.' })
  const [, mimeType, encoded] = match
  const buffer = Buffer.from(encoded, 'base64')
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== encoded) {
    return res.status(413).json({ error: 'Image must be no larger than 5 MB.' })
  }
  const credentials = cloudinaryCredentials()
  if (!credentials) return res.status(503).json({ error: 'Cloudinary image storage is not configured.' })

  try {
    const timestamp = Math.floor(Date.now() / 1000)
    const folder = `zxsolarcrm/${context}`
    const signature = crypto.createHash('sha1')
      .update(`folder=${folder}&timestamp=${timestamp}${credentials.apiSecret}`)
      .digest('hex')
    const form = new FormData()
    form.append('file', new Blob([buffer], { type: mimeType }), `upload.${mimeExtensions[mimeType]}`)
    form.append('api_key', credentials.apiKey)
    form.append('timestamp', String(timestamp))
    form.append('folder', folder)
    form.append('signature', signature)
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(credentials.cloudName)}/image/upload`, {
      method: 'POST',
      body: form,
    })
    const result = await response.json()
    if (!response.ok || typeof result.secure_url !== 'string') {
      return res.status(502).json({ error: 'Cloudinary could not store this image.' })
    }
    res.status(201).json({ url: result.secure_url, publicId: result.public_id })
  } catch (error) {
    next(error)
  }
}

module.exports = { create }
