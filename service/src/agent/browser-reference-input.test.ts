import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserInput } from './browser-tools.js';

test('reference click retains explicit identity and normalizes nullable provider fields', () => {
  const input = { action: 'click', reference: 'snapshot:e40', target_id: 'target', observation_id: 'snapshot' };
  assert.deepEqual(parseBrowserInput('browser_act', {...input, url:null,text:null,scope:null,locator:null,delta_y:null}),input);
  assert.deepEqual(parseBrowserInput('browser_act', {action:'click',reference:'snapshot:e40'}),{action:'click',reference:'snapshot:e40'});
  for (const invalid of [
    {...input, observation_id:null}, {...input, target_id:null},
    {...input, locator:{role:'link',name:'Story'}}, {...input,url:'https://example.com'},
    {...input,scope:'snapshot:root'}, {...input,observation_id:''},
  ]) assert.throws(()=>parseBrowserInput('browser_act',invalid),/browser_invalid_arguments/);
});
