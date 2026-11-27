function notFound(req, res) {
  res.status(404).json({ error: 'Route not found.' })
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error)
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500
  if (status >= 500 || error.crmConflict) {
    const log = {
      event: error.crmConflict ? 'crm_write_conflict' : 'request_error',
      method: req.method,
      route: req.route?.path || '(unmatched)',
      status,
      error: error.name,
      ...(error.crmConflict ? { resources: error.resources } : {}),
      ...(typeof error.code === 'number' ? { code: error.code } : {}),
      ...(status >= 500 && typeof error.stack === 'string'
        ? { stack: error.stack.split('\n').filter((line) => /^\s+at /.test(line)).slice(0, 8).map((line) => line.trim()) }
        : {}),
    }
    if (error.crmConflict) console.warn(JSON.stringify(log))
    else console.error(JSON.stringify(log))
  }
  const message = status < 500 ? error.message : status === 503 && error.message ? error.message : 'The server could not complete the request.'
  res.status(status).json({ error: message })
}

module.exports = { errorHandler, notFound }
