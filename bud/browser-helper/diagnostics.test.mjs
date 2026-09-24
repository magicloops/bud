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

test('click diagnostics are numeric, bounded and exclude page-bearing fields',()=>{
  const diagnostic=failureDiagnostic(Error('private'),'prepare_click',{
    candidates:900,reason:99,x:Infinity,y:-1,preparation_ms:5000,url:'private',text:'private',
  });
  assert.equal(diagnostic.stage,8);
  assert.equal(diagnostic.candidates,50);
  assert.equal(diagnostic.point_reason,-1);
  assert.equal(diagnostic.point_x,null);
  assert.equal(diagnostic.point_y,0);
  assert.equal(diagnostic.preparation_ms,3000);
  assert.equal(JSON.stringify(diagnostic).includes('private'),false);
});
