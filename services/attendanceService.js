const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const AUTO_CHECKOUT_HOUR = 20
const AUTO_CHECKOUT_MINUTE = 0

function istParts(date = new Date()) {
  const ist = new Date(date.getTime() + IST_OFFSET_MS)
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  }
}

function applyAttendanceAutoCheckout(data, now = new Date(), employeeScope = null) {
  const current = istParts(now)
  const allowedIds = employeeScope?.ids ? new Set(employeeScope.ids) : null
  const allowedNames = employeeScope?.names ? new Set(employeeScope.names) : null
  const rows = []
  data.attendance ||= []
  for (const row of data.attendance) {
    if (!row.checkIn || row.checkOut) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) continue
    if (allowedIds && !(row.userId ? allowedIds.has(row.userId) : allowedNames?.has(row.employee))) continue

    const sessionDate = row.date
    const cutoff = new Date(`${sessionDate}T20:00:00+05:30`)
    if (sessionDate === current.date && current.minutes < AUTO_CHECKOUT_HOUR * 60 + AUTO_CHECKOUT_MINUTE) continue
    if (sessionDate > current.date) continue
    if (Number.isNaN(cutoff.getTime())) continue

    if (row.checkIn) {
      let checkOutAt = cutoff
      if (row.checkInAt) {
        const checkInAt = new Date(row.checkInAt)
        if (!Number.isNaN(checkInAt.getTime()) && checkInAt.getTime() > cutoff.getTime()) {
          checkOutAt = new Date(checkInAt.getTime())
        }
      } else if (row.checkIn) {
        const checkInAt = new Date(`${row.date}T${row.checkIn}:00+05:30`)
        if (!Number.isNaN(checkInAt.getTime()) && checkInAt.getTime() > cutoff.getTime()) {
          checkOutAt = new Date(checkInAt.getTime())
        }
      }
      row.checkOut = checkOutAt.toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
      })
      row.checkOutAt = checkOutAt.toISOString()
      rows.push(row)
    }
  }
  return { changed: rows.length > 0, rows }
}

async function autoCheckoutOpenAttendance(employeeScope = null, now = new Date()) {
  const crmModel = require('../models/crmModel')
  return crmModel.update((data) => applyAttendanceAutoCheckout(data, now, employeeScope))
}

module.exports = { applyAttendanceAutoCheckout, autoCheckoutOpenAttendance, istParts }
