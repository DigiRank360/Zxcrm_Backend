const { test } = require('node:test')
const assert = require('node:assert/strict')
const { routeLead } = require('./leadService')

test('routing counts only active open leads assigned to eligible employees', () => {
  const agents = [
    { id: 'a', maxOpenLeads: 2 },
    { id: 'b', maxOpenLeads: 2 },
  ]
  const leads = [
    { agentId: 'a', status: 'New' },
    { agentId: 'a', status: 'Converted' },
    { agentId: 'b', status: 'New', deletedAt: '2026-01-01' },
    { agentId: 'other', status: 'New' },
    { agentId: null, status: 'New' },
  ]
  const result = routeLead({}, agents, leads)
  assert.equal(result.agentId, 'b')
  assert.match(result.assignmentReason, /0\/2/)
})

test('routing preserves capacity and deterministic tie breaking', () => {
  const agents = [{ id: 'b', maxOpenLeads: 1 }, { id: 'a', maxOpenLeads: 1 }]
  assert.equal(routeLead({}, agents, []).agentId, 'a')
  const leads = [{ agentId: 'a', status: 'New' }, { agentId: 'b', status: 'New' }]
  assert.equal(routeLead({}, agents, leads).agentId, null)
})
