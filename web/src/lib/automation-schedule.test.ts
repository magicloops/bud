import test from 'node:test'
import assert from 'node:assert/strict'
import { describeLocationTrigger, describeTrigger } from './automation-schedule.ts'

test('location triggers name their places, falling back for deleted ones', () => {
  const names = new Map([['home', 'Home'], ['gym', 'Gym']])
  assert.equal(describeLocationTrigger({ event_type: 'place.arrived', place_trigger: { place_ids: ['home', 'gym'] } }, names), 'When you arrive at Home or Gym')
  assert.equal(describeLocationTrigger({ event_type: 'place.departed', place_trigger: { place_ids: ['gone'] } }, names), 'When you leave a deleted place')
  assert.equal(describeLocationTrigger({ event_type: 'visit.ended', visit_filter: { place_ids: [], min_duration_minutes: 0 } }), 'When a visit ends')
  assert.equal(describeLocationTrigger({ event_type: 'visit.ended', visit_filter: { place_ids: ['gym'], min_duration_minutes: 45 } }, names),
    'When a visit of at least 45 minutes ends at Gym')
  assert.equal(describeTrigger({ event_type: 'contact.added' }), 'When a new contact is observed')
})
