function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function scheduledWeekdays(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  let total = 0
  for (let day = 1; day <= days; day += 1) {
    if (new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay() !== 0) total += 1
  }
  return total
}

function workedHours(row) {
  if (!row?.checkInAt || !row?.checkOutAt) return null
  const seconds = (new Date(row.checkOutAt).getTime() - new Date(row.checkInAt).getTime()) / 1000
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 3600 : null
}

function attendanceValue(row) {
  if (['Absent', 'Leave', 'Holiday'].includes(row.status)) return 0
  if (row.status === 'Half-day') return 0.5
  const hours = workedHours(row)
  return hours !== null && hours < 4 ? 0.5 : 1
}

function calculatePayroll({ attendance, employee, month, deductions }) {
  const rows = attendance.filter((row) =>
    row.date?.startsWith(`${month}-`) &&
    (row.userId ? row.userId === employee.id : row.employee === employee.name))
  const byDate = new Map()
  for (const row of rows) byDate.set(row.date, Math.max(byDate.get(row.date) || 0, attendanceValue(row)))
  const presentDays = [...byDate.values()].filter((value) => value === 1).length
  const halfDays = [...byDate.values()].filter((value) => value === 0.5).length
  const payableDays = presentDays + halfDays * 0.5
  const scheduledDays = scheduledWeekdays(month)
  const attendanceFactor = scheduledDays ? payableDays / scheduledDays : 0
  const grossSalary = Number(employee.monthlySalary)
  const attendanceSalary = Math.round(grossSalary * attendanceFactor * 100) / 100
  const normalizedDeductions = deductions.map((item) => ({
    label: item.label.trim(),
    amount: Math.round(Number(item.amount) * 100) / 100,
  }))
  const totalDeductions = Math.round(normalizedDeductions.reduce((sum, item) => sum + item.amount, 0) * 100) / 100
  if (totalDeductions > attendanceSalary) {
    const error = new Error('Total deductions cannot exceed the attendance-based payable salary.')
    error.status = 400
    throw error
  }
  return {
    grossSalary,
    scheduledDays,
    presentDays,
    halfDays,
    absentDays: Math.max(0, scheduledDays - presentDays - halfDays),
    payableDays,
    attendanceFactor: Math.round(attendanceFactor * 10000) / 10000,
    attendanceSalary,
    attendanceProration: true,
    deductions: normalizedDeductions,
    totalDeductions,
    netSalary: Math.round((attendanceSalary - totalDeductions) * 100) / 100,
  }
}

module.exports = { calculatePayroll, validMonth }
