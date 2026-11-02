const crypto = require('node:crypto')

function webhookAuth(secretKey) {
  return (req, res, next) => {
    const received = req.get('x-webhook-secret')
    const expected = process.env[secretKey]
    if (!received || !expected) {
      return res.status(401).json({ success: false, message: 'Webhook authentication failed' })
    }
    const receivedHash = crypto.createHash('sha256').update(received).digest()
    const expectedHash = crypto.createHash('sha256').update(expected).digest()
    if (!crypto.timingSafeEqual(receivedHash, expectedHash)) {
      return res.status(401).json({ success: false, message: 'Invalid webhook secret' })
    }
    next()
  }
}

module.exports = webhookAuth
