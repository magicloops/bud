import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDescribe, shortBuildVersion } from './build-info.ts'

test('shortBuildVersion extracts the release tag from a describe string', () => {
  assert.equal(shortBuildVersion('v0.1.13-2-g2a57857'), 'v0.1.13')
  assert.equal(shortBuildVersion('v0.1.13-0-g1234abc-dirty'), 'v0.1.13')
  assert.equal(shortBuildVersion('v0.1.13'), 'v0.1.13')
})

test('shortBuildVersion passes through non-tag describe strings', () => {
  // --always fallback in a checkout with no reachable tag: bare short SHA.
  assert.equal(shortBuildVersion('2a57857'), '2a57857')
  assert.equal(shortBuildVersion('unknown'), 'unknown')
  // Tag-like but not a release tag.
  assert.equal(shortBuildVersion('nightly-3-gabc1234'), 'nightly-3-gabc1234')
})

test('buildDescribe falls back outside a Vite build', () => {
  // node --test has no Vite define; the guard must not throw.
  assert.equal(buildDescribe(), 'unknown')
})
