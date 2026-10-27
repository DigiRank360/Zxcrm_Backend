function employeeOwnsApplication(data, application, userId) {
  return application?.assignedEmployeeId === userId
}

function employeeOwnsInstallation(data, installation, userId) {
  if (!installation) return false
  if (installation.assignedEmployeeId === userId) return true
  return employeeOwnsApplication(
    data,
    (data.applications || []).find((application) => application.id === installation.applicationId),
    userId,
  )
}

function employeeOwnsTicket(data, ticket, userId) {
  if (!ticket) return false
  return employeeOwnsInstallation(
    data,
    (data.installations || []).find((installation) => installation.id === ticket.installationId),
    userId,
  )
}

module.exports = { employeeOwnsApplication, employeeOwnsInstallation, employeeOwnsTicket }
