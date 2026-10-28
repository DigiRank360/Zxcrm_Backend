const crypto = require('node:crypto')
const crmModel = require('../models/crmModel')
const userModel = require('../models/userModel')
const { privateDownloadUrl, signedUploadParameters } = require('../services/cloudinaryService')
const { decryptBankDetails, encryptBankDetails } = require('../services/hrSensitiveData')
const { calculatePayroll, validMonth: validPayrollMonth } = require('../services/payrollService')

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const documentCategories = new Set([
  'Aadhaar Card', 'PAN Card', 'P.A.', 'T.A.', 'Bank Passbook', 'Last Joining Letter',
  'Identity proof', 'Bank proof',
])
const documentMimeTypes = {
  'application/pdf': { extension: 'pdf', signature: Buffer.from('%PDF-') },
  'image/jpeg': { extension: 'jpg', signature: Buffer.from([0xff, 0xd8, 0xff]) },
  'image/png': { extension: 'png', signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
}
const MAX_DOCUMENT_BYTES = 7 * 1024 * 1024
const MAX_DOCUMENTS_PER_EMPLOYEE = 20

function validMonth(value) {
  return validPayrollMonth(value)
}

function validDate(value) {
  if (value === undefined || value === '') return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validAmount(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value))
}

function publicDocument(document) {
  const { publicId, format, ...metadata } = document
  return metadata
}

function profileResponse(user, profile = {}, includeSalary = true) {
  const {
    bankDetailsEncrypted,
    documents = [],
    ...publicProfile
  } = profile
  return {
    ...publicProfile,
    ...(includeSalary ? {} : { monthlySalary: undefined }),
    ...(bankDetailsEncrypted ? { bankDetails: decryptBankDetails(bankDetailsEncrypted) } : { bankDetails: null }),
    documents: documents.map(publicDocument),
    employee: {
      id: user.id,
      reference: `EMP-${user.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      name: user.name,
      username: user.username,
      email: user.username.includes('@') ? user.username : '',
      phone: user.phone || '',
      role: user.role,
    },
  }
}

function bankDetailsFrom(input) {
  const { accountHolder, bankName, accountNumber, ifsc } = input || {}
  if ([accountHolder, bankName, accountNumber, ifsc].some((value) => typeof value !== 'string') ||
      !accountHolder.trim() || accountHolder.trim().length > 120 ||
      !bankName.trim() || bankName.trim().length > 120 ||
      !/^\d{6,34}$/.test(accountNumber.replace(/\s/g, '')) ||
      !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.trim().toUpperCase())) {
    return null
  }
  return {
    accountHolder: accountHolder.trim(),
    bankName: bankName.trim(),
    accountNumber: accountNumber.replace(/\s/g, ''),
    ifsc: ifsc.trim().toUpperCase(),
  }
}

async function uploadPrivateDocument(userId, category, dataUrl, uploadedBy) {
  if (!documentCategories.has(category) || typeof dataUrl !== 'string') {
    const error = new Error('Choose a valid document type and select a supported document.')
    error.status = 400
    throw error
  }
  const match = dataUrl.match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/]+={0,2})$/)
  if (!match) {
    const error = new Error('Upload a PDF, JPEG, or PNG document.')
    error.status = 400
    throw error
  }
  const [, mimeType, encoded] = match
  const buffer = Buffer.from(encoded, 'base64')
  const type = documentMimeTypes[mimeType]
  if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES || buffer.toString('base64') !== encoded ||
      buffer.length < type.signature.length || !buffer.subarray(0, type.signature.length).equals(type.signature)) {
    const error = new Error('Document must be a valid PDF, JPEG, or PNG no larger than 7 MB.')
    error.status = 400
    throw error
  }

  const timestamp = Math.floor(Date.now() / 1000)
  const publicId = crypto.randomUUID()
  const folder = `zxsolarcrm/employee-documents/${userId}`
  const parameters = { folder, public_id: publicId, timestamp, type: 'authenticated' }
  const { credentials, signature } = signedUploadParameters(parameters)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType }), `document.${type.extension}`)
  form.append('api_key', credentials.api_key)
  form.append('timestamp', String(timestamp))
  form.append('folder', folder)
  form.append('public_id', publicId)
  form.append('type', 'authenticated')
  form.append('signature', signature)
  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(credentials.cloud_name)}/raw/upload`, {
    method: 'POST',
    body: form,
  })
  const result = await response.json()
  if (!response.ok || typeof result.public_id !== 'string') {
    const error = new Error('Cloudinary could not store this private document.')
    error.status = 502
    throw error
  }
  return {
    id: crypto.randomUUID(),
    category,
    fileName: `document.${type.extension}`,
    mimeType,
    publicId: result.public_id,
    format: result.format || type.extension,
    uploadedAt: new Date().toISOString(),
    uploadedBy,
  }
}

async function employeeProfile(userId, { includeInactive = false } = {}) {
  const users = await userModel.findAll({ includeInactive })
  const user = users.find((item) => item.id === userId && ['employee', 'technician'].includes(item.role))
  if (!user) return null
  const data = await crmModel.findAll()
  const profile = (data.hrProfiles || []).find((item) => item.userId === userId)
  return { user, profile: profile || {} }
}

async function listEmployees(req, res, next) {
  try {
    const [users, data] = await Promise.all([
      userModel.findAll({ includeInactive: true }),
      crmModel.findAll(),
    ])
    const profiles = new Map((data.hrProfiles || []).map((profile) => [profile.userId, profile]))
    res.json(users.filter((user) => ['employee', 'technician'].includes(user.role))
      .map((user) => ({
        ...user,
        ...profileResponse(user, profiles.get(user.id), true),
      })))
  } catch (error) {
    next(error)
  }
}

const personalFields = ['presentAddress', 'temporaryAddress', 'motherName', 'fatherName']

function personalDetailsFrom(input) {
  const body = input || {}
  const { dateOfBirth = '' } = body
  if (personalFields.some((field) => body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 300)) ||
      !validDate(dateOfBirth) || (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10))) return null
  return {
    ...Object.fromEntries(personalFields.map((field) => [field, (body[field] || '').trim()])),
    dateOfBirth,
  }
}

async function savePersonalDetails(userId, details) {
  return crmModel.update((data) => {
    data.hrProfiles ||= []
    let profile = data.hrProfiles.find((item) => item.userId === userId)
    if (!profile) {
      profile = { userId }
      data.hrProfiles.push(profile)
    }
    Object.assign(profile, details, { updatedAt: new Date().toISOString() })
    return details
  })
}

async function updateMyPersonalDetails(req, res, next) {
  const details = personalDetailsFrom(req.body)
  if (!details) return res.status(400).json({ error: 'Provide valid addresses, parent names (max 300 characters) and a past date of birth.' })
  try {
    res.json(await savePersonalDetails(req.user.id, details))
  } catch (error) {
    next(error)
  }
}

async function updateEmployeePersonalDetails(req, res, next) {
  const details = personalDetailsFrom(req.body)
  if (!details) return res.status(400).json({ error: 'Provide valid addresses, parent names (max 300 characters) and a past date of birth.' })
  try {
    const users = await userModel.findAll({ includeInactive: true })
    if (!users.some((user) => user.id === req.params.id && ['employee', 'technician'].includes(user.role))) {
      return res.status(404).json({ error: 'Employee account not found.' })
    }
    res.json(await savePersonalDetails(req.params.id, details))
  } catch (error) {
    next(error)
  }
}

async function updateEmployee(req, res, next) {
  const { department = '', jobTitle = '', joiningDate = '', monthlySalary } = req.body || {}
  if ([department, jobTitle].some((value) => typeof value !== 'string' || value.length > 100) ||
      !validDate(joiningDate) ||
      !validAmount(monthlySalary) || Number(monthlySalary) < 0 || Number(monthlySalary) > 1000000000) {
    return res.status(400).json({ error: 'Provide a valid department, job title, joining date, and monthly salary.' })
  }
  try {
    const users = await userModel.findAll({ includeInactive: true })
    if (!users.some((user) => user.id === req.params.id && ['employee', 'technician'].includes(user.role))) {
      return res.status(404).json({ error: 'Employee account not found.' })
    }
    const profile = await crmModel.update((data) => {
      data.hrProfiles ||= []
      const current = data.hrProfiles.find((item) => item.userId === req.params.id)
      const updated = {
        userId: req.params.id,
        department: department.trim(),
        jobTitle: jobTitle.trim(),
        joiningDate,
        monthlySalary: Math.round(Number(monthlySalary) * 100) / 100,
        updatedAt: new Date().toISOString(),
      }
      if (current) Object.assign(current, updated)
      else data.hrProfiles.push(updated)
      return updated
    })
    res.json(profile)
  } catch (error) {
    next(error)
  }
}

  async function getMyProfile(req, res, next) {
    try {
      const result = await employeeProfile(req.user.id)
      if (!result) return res.status(404).json({ error: 'Employee profile not found.' })
      res.json(profileResponse(result.user, result.profile))
    } catch (error) {
      next(error)
    }
  }

  async function updateMyBankDetails(req, res, next) {
    return updateBankDetails(req.user.id, req.body, res, next)
  }

  async function updateEmployeeBankDetails(req, res, next) {
    try {
      const employee = await employeeProfile(req.params.id)
      if (!employee) return res.status(404).json({ error: 'Active employee account not found.' })
      return updateBankDetails(req.params.id, req.body, res, next)
    } catch (error) {
      next(error)
    }
  }

  async function updateBankDetails(userId, body, res, next) {
    const bankDetails = bankDetailsFrom(body)
    if (!bankDetails) {
      return res.status(400).json({ error: 'Provide account holder, bank name, account number, and valid IFSC code.' })
    }
    try {
      const encrypted = encryptBankDetails(bankDetails)
      const profile = await crmModel.update((data) => {
        data.hrProfiles ||= []
        let current = data.hrProfiles.find((item) => item.userId === userId)
        if (!current) {
          current = { userId }
          data.hrProfiles.push(current)
        }
        current.bankDetailsEncrypted = encrypted
        current.updatedAt = new Date().toISOString()
        return current
      })
      res.json({
        bankDetails: decryptBankDetails(profile.bankDetailsEncrypted),
        updatedAt: profile.updatedAt,
      })
    } catch (error) {
      next(error)
    }
  }

  async function uploadMyDocument(req, res, next) {
    try {
      const result = await uploadEmployeeDocument(req.user.id, req.body, req.user.id)
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  }

  async function uploadEmployeeDocument(userId, body, uploadedBy) {
    const { category, document } = body || {}
    const employee = await employeeProfile(userId)
    if (!employee) {
      const error = new Error('Active employee account not found.')
      error.status = 404
      throw error
    }
    if ((employee.profile.documents || []).length >= MAX_DOCUMENTS_PER_EMPLOYEE) {
      const error = new Error(`An employee can have up to ${MAX_DOCUMENTS_PER_EMPLOYEE} documents.`)
      error.status = 409
      throw error
    }
    const metadata = await uploadPrivateDocument(userId, category, document, uploadedBy)
    const saved = await crmModel.update((data) => {
      data.hrProfiles ||= []
      let profile = data.hrProfiles.find((item) => item.userId === userId)
      if (!profile) {
        profile = { userId }
        data.hrProfiles.push(profile)
      }
      profile.documents ||= []
      profile.documents.unshift(metadata)
      profile.updatedAt = new Date().toISOString()
      return metadata
    })
    return publicDocument(saved)
  }

  async function uploadEmployeeDocumentByHr(req, res, next) {
    try {
      const result = await uploadEmployeeDocument(req.params.id, req.body, req.user.id)
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  }

  async function downloadEmployeeDocument(req, res, next) {
    try {
      const result = await employeeProfile(req.params.id)
      const document = result?.profile.documents?.find((item) => item.id === req.params.documentId)
      if (!document) return res.status(404).json({ error: 'Employee document not found.' })
      const response = await fetch(privateDownloadUrl(document))
      if (!response.ok) return res.status(502).json({ error: 'Cloudinary could not retrieve this private document.' })
      res.set({
        'Content-Type': document.mimeType,
        'Content-Disposition': `attachment; filename="${document.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${document.id}.${document.format}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.send(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      next(error)
    }
  }

  async function downloadMyDocument(req, res, next) {
    req.params.id = req.user.id
    return downloadEmployeeDocument(req, res, next)
  }

async function listPayroll(req, res, next) {
  try {
    const data = await crmModel.findAll()
    res.json([...(data.payroll || [])].sort((a, b) => b.month.localeCompare(a.month) || a.employeeName.localeCompare(b.employeeName)))
  } catch (error) {
    next(error)
  }
}

async function previewPayroll(req, res, next) {
  const { employeeId, month } = req.query
  if (typeof employeeId !== 'string' || !validMonth(month)) {
    return res.status(400).json({ error: 'Provide an employee and a valid YYYY-MM pay month.' })
  }
  try {
    const [users, data] = await Promise.all([userModel.findAll(), crmModel.findAll()])
    const employee = users.find((user) => user.id === employeeId && ['employee', 'technician'].includes(user.role))
    const profile = (data.hrProfiles || []).find((item) => item.userId === employeeId)
    if (!employee || !profile) return res.status(404).json({ error: 'Set up an active employee profile and monthly salary first.' })
    res.json({
      employeeId,
      employeeName: employee.name,
      month,
      ...calculatePayroll({ attendance: data.attendance || [], holidays: data.holidays || [], employee: { ...employee, monthlySalary: profile.monthlySalary }, month, deductions: [] }),
    })
  } catch (error) {
    next(error)
  }
}

async function createPayroll(req, res, next) {
  const { employeeId, month, deductions = [] } = req.body || {}
  if (typeof employeeId !== 'string' || !employeeId || !validMonth(month) ||
      !Array.isArray(deductions) || deductions.length > 30 ||
      deductions.some((item) => !item || typeof item.label !== 'string' || !item.label.trim() ||
        item.label.trim().length > 100 ||
        !validAmount(item.amount) || Number(item.amount) < 0)) {
    return res.status(400).json({ error: 'Provide an employee, a YYYY-MM pay month, and valid manual deduction entries.' })
  }
  try {
    const [users, result] = await Promise.all([
      userModel.findAll(),
      crmModel.findAll(),
    ])
    const employee = users.find((user) => user.id === employeeId && ['employee', 'technician'].includes(user.role))
    const profile = (result.hrProfiles || []).find((item) => item.userId === employeeId)
    if (!employee || !profile) return res.status(400).json({ error: 'Set up an active employee profile and monthly salary before payroll.' })
    const calculation = calculatePayroll({
      attendance: result.attendance || [],
      holidays: result.holidays || [],
      employee: { ...employee, monthlySalary: profile.monthlySalary },
      month,
      deductions,
    })

    const payroll = await crmModel.update((data) => {
      data.payroll ||= []
      if (data.payroll.some((item) => item.employeeId === employeeId && item.month === month)) {
        const error = new Error('Payroll already exists for this employee and month.')
        error.status = 409
        throw error
      }
      const record = {
        id: crypto.randomUUID(),
        employeeId,
        employeeName: employee.name,
        month,
        currency: 'INR',
        ...calculation,
        status: 'Pending',
        createdAt: new Date().toISOString(),
      }
      data.payroll.push(record)
      return record
    })
    res.status(201).json(payroll)
  } catch (error) {
    next(error)
  }
}

async function markPaid(req, res, next) {
  try {
    const payroll = await crmModel.update((data) => {
      const record = (data.payroll || []).find((item) => item.id === req.params.id)
      if (!record) {
        const error = new Error('Payroll record not found.')
        error.status = 404
        throw error
      }
      if (record.status === 'Paid') {
        const error = new Error('This payroll record is already marked as paid.')
        error.status = 409
        throw error
      }
      record.status = 'Paid'
      record.paidAt = new Date().toISOString()
      record.paidBy = req.user.id
      return record
    })
    res.json(payroll)
  } catch (error) {
    next(error)
  }
}

async function syncPayroll(req, res, next) {
  try {
    const [users, data] = await Promise.all([userModel.findAll(), crmModel.findAll()])
    const current = (data.payroll || []).find((item) => item.id === req.params.id)
    if (!current) return res.status(404).json({ error: 'Payroll record not found.' })
    if (current.status === 'Paid') return res.status(409).json({ error: 'Paid payroll cannot be recalculated.' })
    const employee = users.find((user) => user.id === current.employeeId)
    const profile = (data.hrProfiles || []).find((item) => item.userId === current.employeeId)
    if (!employee || !profile) return res.status(400).json({ error: 'Employee salary profile is no longer available.' })
    const calculation = calculatePayroll({
      attendance: data.attendance || [],
      holidays: data.holidays || [],
      employee: { ...employee, monthlySalary: profile.monthlySalary },
      month: current.month,
      deductions: current.deductions || [],
    })
    const payroll = await crmModel.update((nextData) => {
      const record = (nextData.payroll || []).find((item) => item.id === req.params.id)
      if (!record || record.status === 'Paid') {
        const error = new Error('This payroll cannot be recalculated.')
        error.status = 409
        throw error
      }
      Object.assign(record, calculation, { updatedAt: new Date().toISOString() })
      return record
    })
    res.json(payroll)
  } catch (error) {
    next(error)
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]))
}

async function downloadPayrollSlip(req, res, next) {
  try {
    const data = await crmModel.findAll()
    const record = (data.payroll || []).find((item) => item.id === req.params.id)
    if (!record) return res.status(404).json({ error: 'Payroll record not found.' })
    const deductions = (record.deductions || []).map((item) =>
      `<tr><td>${escapeHtml(item.label)}</td><td>${money(item.amount)}</td></tr>`).join('')
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Salary slip - ${escapeHtml(record.employeeName)} - ${escapeHtml(record.month)}</title>
<style>
body{font-family:Arial,sans-serif;color:#172554;background:#f8fafc;margin:0;padding:32px}
.slip{max-width:760px;margin:auto;background:#fff;border:1px solid #dbeafe;border-radius:16px;padding:32px;box-shadow:0 10px 30px #0f172a12}
h1{margin:0;color:#1d4ed8;font-size:26px}h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid #e2e8f0;padding-bottom:8px}
.muted{color:#64748b;font-size:13px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:24px}.label{color:#64748b;font-size:12px}.value{font-weight:700;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:10px;border-bottom:1px solid #e2e8f0}td:last-child{text-align:right;font-weight:600}
.total{display:flex;justify-content:space-between;background:#eff6ff;border-radius:10px;padding:16px;font-size:18px;font-weight:700;color:#1e40af;margin-top:18px}
@media print{body{background:#fff;padding:0}.slip{border:0;box-shadow:none}}
</style></head><body><main class="slip">
<h1>ZX Solar CRM</h1><p class="muted">Monthly salary slip · ${escapeHtml(record.month)}</p>
<div class="grid"><div><div class="label">Employee</div><div class="value">${escapeHtml(record.employeeName)}</div></div>
<div><div class="label">Payment status</div><div class="value">${escapeHtml(record.status)}</div></div>
<div><div class="label">Scheduled days</div><div class="value">${record.scheduledDays ?? '—'}</div></div>
<div><div class="label">Payable days</div><div class="value">${record.payableDays ?? '—'}</div></div></div>
<h2>Attendance summary</h2><table><tr><td>Present days</td><td>${record.presentDays ?? 0}</td></tr><tr><td>Half days</td><td>${record.halfDays ?? 0}</td></tr><tr><td>Absent / unpaid days</td><td>${record.absentDays ?? 0}</td></tr><tr><td>Attendance-based salary</td><td>${money(record.attendanceSalary ?? record.grossSalary)}</td></tr></table>
<h2>Deductions</h2><table>${deductions || '<tr><td>No deductions</td><td>—</td></tr>'}</table>
<div class="total"><span>Net pay</span><span>${money(record.netSalary)}</span></div>
<p class="muted">Generated by ZX Solar CRM. This is a system-generated salary statement.</p>
</main></body></html>`
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="salary-slip-${record.month}-${record.id}.html"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.send(html)
  } catch (error) {
    next(error)
  }
}

module.exports = {
  updateEmployeePersonalDetails,
  updateMyPersonalDetails,
  createPayroll,
  downloadEmployeeDocument,
  downloadPayrollSlip,
  downloadMyDocument,
  getMyProfile,
  listEmployees,
  listPayroll,
  previewPayroll,
  markPaid,
  syncPayroll,
  updateEmployee,
  updateEmployeeBankDetails,
  updateMyBankDetails,
  uploadEmployeeDocumentByHr,
  uploadMyDocument,
}
