import test from 'node:test';
import assert from 'node:assert/strict';
import { profileEnvironment } from './local-dev.mjs';

test('local profiles override stale origin, audience and browser transport settings', () => {
  for (const [profile, origin, api] of [
    ['http', 'http://localhost:5173', 'http://localhost:3000'],
    ['https', 'https://localhost:3443', ''],
  ]) {
    const result = profileEnvironment(profile, {
      APP_BASE_URL: 'https://old.ngrok.app', BETTER_AUTH_URL: 'https://old.ngrok.app',
      BUD_DEV_HTTPS_ORIGIN: 'https://old.ngrok.app', API_AUDIENCE: 'old', VITE_API_BASE_URL: 'old',
      DATABASE_URL: 'unchanged',
    });
    assert.equal(result.APP_BASE_URL, origin);
    assert.equal(result.BETTER_AUTH_URL, origin);
    assert.equal(result.BUD_DEV_HTTPS_ORIGIN, origin);
    assert.equal(result.API_AUDIENCE, `${origin}/api`);
    assert.equal(result.VITE_API_BASE_URL, api);
    assert.equal(result.DATABASE_URL, 'unchanged');
    assert.ok(result.BETTER_AUTH_TRUSTED_ORIGINS.split(',').includes(origin));
  }
});

test('ngrok uses only its named URL setting and preserves independent preview settings', () => {
  const result = profileEnvironment('ngrok', {
    BUD_DEV_NGROK_URL: 'https://example.ngrok.app/', BUD_DEV_HTTPS_ORIGIN: 'https://wrong.ngrok.app',
    BUD_DEV_PROXY_BASE_DOMAIN: 'bud.systems', BUD_DEV_PROXY_PUBLIC_PORT: '',
  });
  assert.equal(result.APP_BASE_URL, 'https://example.ngrok.app');
  assert.equal(result.BUD_DEV_PROXY_BASE_DOMAIN, 'bud.systems');
  assert.equal(result.BUD_DEV_PROXY_PUBLIC_PORT, '');
  assert.equal(result.VITE_API_BASE_URL, '');
});

test('invalid profiles and non-origin ngrok URLs fail before spawning anything', () => {
  assert.throws(() => profileEnvironment('other', {}));
  for (const url of [undefined, 'http://example.com', 'https://example.com/path', 'https://user:password@example.com', 'https://example.com/?token=x']) {
    assert.throws(() => profileEnvironment('ngrok', { BUD_DEV_NGROK_URL: url }));
  }
});
