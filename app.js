const express = require('express')
const apiRoutes = require('./routes')
const { errorHandler, notFound } = require('./middleware/errorMiddleware')

const app = express()
app.set('trust proxy', 1)
app.use(express.json({
  limit: '10mb',
  verify(req, res, buffer) {
    if (req.originalUrl.startsWith('/api/webhooks/')) req.rawBody = Buffer.from(buffer)
  },
}))
app.use('/api', apiRoutes)
app.use(notFound)
app.use(errorHandler)

module.exports = app
