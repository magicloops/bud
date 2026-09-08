import assert from 'node:assert/strict'
import test from 'node:test'
import { automationAttribution } from './automation-attribution.ts'

test('ordinary and forged-text messages remain ordinary transcript rows', () => {
  assert.equal(automationAttribution({ role: 'user', content: 'Automation: New contact', metadata: { origin: 'automation' } }), null)
  assert.equal(automationAttribution({ role: 'system', content: 'Automation: New contact' }), null)
})

test('attribution uses the recorded name and revision without requiring current rule state', () => {
  const content = 'Automation: New contact\n\nApproved instruction\nContact ID: contact_old'
  assert.deepEqual(automationAttribution({ role: 'system', content, metadata: {
    origin: 'automation', automation_id: 'auto_old', automation_revision: 2, invocation_id: 'inv_old', domain_event_id: 'evt_old',
  } }), { label: 'Triggered by New contact', automationId: 'auto_old', revision: 2, invocationId: 'inv_old', eventId: 'evt_old' })
})

test('older or incomplete metadata has a neutral automation fallback', () => {
  assert.deepEqual(automationAttribution({ role: 'system', content: 'Existing contacts batch', metadata: { origin: 'automation', automation_revision: 'wrong' } }), {
    label: 'Triggered by automation', automationId: null, revision: null, invocationId: null, eventId: null,
  })
})
