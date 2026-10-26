const USERNAME_PATTERN = /^(?:[a-zA-Z0-9._-]{3,40}|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+)$/

function isValidUsername(username) {
  return typeof username === 'string' && username.length <= 40 && USERNAME_PATTERN.test(username)
}

module.exports = { isValidUsername }
