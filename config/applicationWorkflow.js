const stages = [
  { title: 'Registration', owner: 'Consumer' },
  { title: 'Application', owner: 'Consumer' },
  { title: 'Feasibility', owner: 'Discom' },
  { title: 'Vendor Selection', owner: 'Consumer' },
  { title: 'Upload Agreement', owner: 'Vendor' },
  { title: 'Pre-site Inspection', owner: 'Vendor' },
  { title: 'Material Dispatch', owner: 'Vendor' },
  { title: 'Installation', owner: 'Vendor' },
  { title: 'Post-site Inspection', owner: 'Discom' },
  { title: 'Project Commissioning', owner: 'Discom' },
  { title: 'Subsidy Request', owner: 'Consumer' },
  { title: 'Subsidy Disbursal', owner: 'REC' },
]

const approvalStages = [2, 8]

function emptyStep(index) {
  return { startedAt: '', completedAt: '', documents: [], approvalStatus: approvalStages.includes(index) ? 'Pending' : 'Not required' }
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return steps
  if (steps.length === stages.length) {
    return steps.map((step, index) => ({
      ...emptyStep(index),
      ...step,
      documents: Array.isArray(step.documents) ? step.documents : [],
      approvalStatus: approvalStages.includes(index) ? (step.approvalStatus || 'Pending') : 'Not required',
    }))
  }
  if (steps.length !== 7) return steps

  const migrated = stages.map((_, index) => emptyStep(index))
  for (const index of [0, 1, 2, 3, 4]) migrated[index] = { ...migrated[index], ...steps[index] }

  const installation = steps[5] || {}
  if (installation.completedAt) {
    migrated[5] = { ...migrated[5], startedAt: steps[4]?.completedAt || installation.startedAt || '', completedAt: installation.completedAt }
    migrated[6] = { ...migrated[6], startedAt: installation.completedAt, completedAt: installation.completedAt }
  } else {
    migrated[5] = { ...migrated[5], startedAt: installation.startedAt || '' }
  }
  migrated[7] = { ...migrated[7], ...installation }
  migrated[8] = {
    ...migrated[8],
    ...(steps[6] || {}),
    approvalStatus: steps[6]?.approvalStatus || 'Pending',
  }
  return migrated
}

function migrateApplications(data) {
  let changed = false
  for (const application of data.applications || []) {
    if (application.steps?.length === 7) {
      application.steps = normalizeSteps(application.steps)
      changed = true
    }
  }
  return changed
}

module.exports = { approvalStages, migrateApplications, normalizeSteps, stages }
