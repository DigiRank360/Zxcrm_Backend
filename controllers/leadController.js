const leadService = require('../services/leadService')

async function autoAssign(req, res, next) {
  try {
    res.json(await leadService.autoAssign())
  } catch (error) {
    next(error)
  }
}

module.exports = { autoAssign }
