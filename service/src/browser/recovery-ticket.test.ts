import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRecoveryTickets } from './recovery-ticket.js';
import type { BrowserSession } from './control-repository.js';

test('recovery proof is authenticated, scoped, expiring and stable across service instances', () => {
  let now = 1_000;
  const tickets = new BrowserRecoveryTickets('fixture-secret', () => now);
  const session = { id: 'session', created_by_user_id: 'owner', generation: 'gen', boot_id: 'boot', control_epoch: 4 } as BrowserSession;
  const ticket = tickets.issue(session, 'auth:viewer');
  assert.equal(new BrowserRecoveryTickets('fixture-secret', () => now).verify(ticket, session, 'auth:viewer').epoch, 4);
  for (const patch of [{ id: 'other' }, { created_by_user_id: 'other' }, { generation: 'new' }, { boot_id: 'new' }])
    assert.throws(() => tickets.verify(ticket, { ...session, ...patch }, 'auth:viewer'), /recovery_invalid/);
  assert.throws(() => tickets.verify(ticket, session, 'other:viewer'), /recovery_invalid/);
  assert.throws(() => tickets.verify(`x${ticket}`, session, 'auth:viewer'), /recovery_invalid/);
  assert.throws(() => new BrowserRecoveryTickets('different-secret', () => now).verify(ticket, session, 'auth:viewer'), /recovery_invalid/);
  now += 10 * 60_000;
  assert.throws(() => tickets.verify(ticket, session, 'auth:viewer'), /recovery_invalid/);
});
