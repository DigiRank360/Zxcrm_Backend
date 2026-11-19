function currentMaintenanceTickets(tickets) {
  const activeByInstallation = new Map()
  for (const ticket of tickets || []) {
    if (ticket.status === 'Completed') continue
    if (!ticket.installationId) continue
    const current = activeByInstallation.get(ticket.installationId)
    if (!current || String(ticket.dueDate).localeCompare(String(current.dueDate)) < 0) {
      activeByInstallation.set(ticket.installationId, ticket)
    }
  }
  return (tickets || []).filter((ticket) =>
    ticket.status === 'Completed' ||
    !ticket.installationId ||
    activeByInstallation.get(ticket.installationId)?.id === ticket.id)
}

module.exports = { currentMaintenanceTickets }
