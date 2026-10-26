function notFound(req, res) {
  res.status(404).json({ error: 'Route not found.' })
}

function errorHandler(error, req, res, next) {
  console.error(error)
  if (res.headersSent) return next(error)
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500
  const message = status < 500 ? error.message : status === 503 && error.message ? error.message : 'The server could not complete the request.'
  res.status(status).json({ error: message })
}

module.exports = { errorHandler, notFound }
