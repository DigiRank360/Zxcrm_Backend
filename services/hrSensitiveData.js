const crypto = require('node:crypto')

function encryptionKey() {
  const key = process.env.HR_DATA_ENCRYPTION_KEY || ''
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    const error = new Error('Set HR_DATA_ENCRYPTION_KEY to a 32-byte (64-character hexadecimal) key before using employee bank details.')
    error.status = 503
    throw error
  }
  return Buffer.from(key, 'hex')
}

function encryptBankDetails(details) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  }
}

function decryptBankDetails(encrypted) {
  if (!encrypted) return null
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(encrypted.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'hex')),
    decipher.final(),
  ])
  return JSON.parse(plaintext.toString('utf8'))
}

module.exports = { decryptBankDetails, encryptBankDetails }
