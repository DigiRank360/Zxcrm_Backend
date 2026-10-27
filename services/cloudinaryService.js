const { v2: cloudinary } = require('cloudinary')

function getCredentials() {
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    return {
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    }
  }
  if (process.env.CLOUDINARY_URL) {
    try {
      const url = new URL(process.env.CLOUDINARY_URL)
      if (url.protocol === 'cloudinary:' && url.username && url.password && url.hostname) {
        return { cloud_name: url.hostname, api_key: url.username, api_secret: url.password }
      }
    } catch {
      return null
    }
  }
  return null
}

function requireCredentials() {
  const credentials = getCredentials()
  if (!credentials) {
    const error = new Error('Cloudinary document storage is not configured.')
    error.status = 503
    throw error
  }
  return credentials
}

function signedUploadParameters(parameters) {
  const credentials = requireCredentials()
  return {
    credentials,
    signature: cloudinary.utils.api_sign_request(parameters, credentials.api_secret),
  }
}

function privateDownloadUrl(document) {
  const credentials = requireCredentials()
  return cloudinary.utils.private_download_url(document.publicId, document.format, {
    ...credentials,
    resource_type: 'raw',
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    attachment: true,
  })
}

module.exports = { getCredentials, privateDownloadUrl, requireCredentials, signedUploadParameters }
