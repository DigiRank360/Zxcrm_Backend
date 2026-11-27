const express = require('express')
const apiRoutes = require('./routes')
const { errorHandler, notFound } = require('./middleware/errorMiddleware')

const app = express()
app.set('trust proxy', 1)
app.use((req, res, next) => {
  if (process.env.CRM_PERF_LOG !== '1' && process.env.NODE_ENV !== 'development') return next()
  const started = process.hrtime.bigint()
  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6
    if (durationMs >= 1000) {
      console.warn(JSON.stringify({
        event: 'slow_http_request',
        method: req.method,
        route: req.route?.path || '(unmatched)',
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      }))
    }
  })
  next()
})
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
