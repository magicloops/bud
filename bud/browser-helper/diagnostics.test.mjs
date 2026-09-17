import test from 'node:test';
import assert from 'node:assert/strict';
import { failureDiagnostic } from './diagnostics.mjs';
test('failure diagnostics expose only fixed stages and boolean signals', () => {
  const error = new Error('secret-url secret-password <div> intercepts pointer events; element is not stable; waiting for scheduled navigations');
  error.name = 'TimeoutError';
  const diagnostic = failureDiagnostic(error, 'click');
  assert.equal(diagnostic.stage, 5);
  assert.equal(diagnostic.timeout, true);
  assert.equal(diagnostic.intercepted, true);
  assert.equal(diagnostic.unstable, true);
  assert.equal(diagnostic.navigation_wait, true);
  assert.equal(JSON.stringify(diagnostic).includes('secret'), false);
  assert.equal(failureDiagnostic(new Error('private'), 'private').stage, -1);
  assert.equal(failureDiagnostic(null, null).timeout, false);
});
