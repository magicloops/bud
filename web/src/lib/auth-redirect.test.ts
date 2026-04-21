import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLoginUrl,
  getLoginRedirectValue,
  normalizeAppRedirectPath,
} from './auth-redirect.ts'

const originalWindow = globalThis.window

const setWindowLocation = (origin: string) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        origin,
      },
    },
  })
}

test('normalizeAppRedirectPath keeps internal app-relative paths', () => {
  assert.equal(normalizeAppRedirectPath('/buds/123?view=terminal#pane'), '/buds/123?view=terminal#pane')
})

test('normalizeAppRedirectPath collapses protocol-relative redirects to root', () => {
  assert.equal(normalizeAppRedirectPath('//evil.example.com/steal'), '/')
})

test('normalizeAppRedirectPath accepts same-origin absolute redirects', () => {
  setWindowLocation('https://bud.test')

  assert.equal(
    normalizeAppRedirectPath('https://bud.test/threads/1?tab=chat#latest'),
    '/threads/1?tab=chat#latest',
  )
})

test('normalizeAppRedirectPath rejects cross-origin absolute redirects', () => {
  setWindowLocation('https://bud.test')

  assert.equal(normalizeAppRedirectPath('https://evil.test/phish'), '/')
})

test('getLoginRedirectValue preserves pathname search and hash', () => {
  assert.equal(
    getLoginRedirectValue('/threads/abc', '?cursor=123', '#composer'),
    '/threads/abc?cursor=123#composer',
  )
})

test('buildLoginUrl encodes the normalized redirect target', () => {
  setWindowLocation('https://bud.test')

  assert.equal(
    buildLoginUrl('/threads/abc?cursor=123#composer'),
    'https://bud.test/login?redirect=%2Fthreads%2Fabc%3Fcursor%3D123%23composer',
  )
})

after(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})
