import test from 'node:test'
import assert from 'node:assert/strict'
import { formatWorkDuration } from './agent-work-duration.ts'

test('formatWorkDuration renders seconds then minutes+seconds', () => {
  assert.equal(formatWorkDuration(400), '0s')
  assert.equal(formatWorkDuration(42_000), '42s')
  assert.equal(formatWorkDuration(88_000), '1m 28s')
  assert.equal(formatWorkDuration(120_000), '2m')
})
