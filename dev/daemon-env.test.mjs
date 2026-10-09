import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { developmentEnvironment, shellEnvironment } from './daemon-env.mjs';

test('setup removes legacy shared paths and preserves deliberate tracing in bash and zsh', () => {
  for (const shell of ['bash', 'zsh']) {
    const result = spawnSync(shell, ['-c', 'source dev/daemon-env.sh https && node -e \'console.log(JSON.stringify(process.env))\''], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
      env: { ...process.env, BUD_BASE_DIR: '/production', BUD_IDENTITY_FILE: '/production/identity.json',
        BUD_TERMINAL_BASE_DIR: '/production', BUD_ENROLLMENT_TOKEN: 'must-clear', BUD_GRPC_CONTROL_URL: 'http://production', BUD_BROWSER_TRACE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const env = JSON.parse(result.stdout);
    assert.ok(env.BUD_BASE_DIR.endsWith('/.bud-dev'));
    assert.equal(env.BUD_SERVER_URL, 'wss://localhost:3443/ws');
    assert.equal(env.BUD_BROWSER_TRACE, '1');
    for (const key of ['BUD_IDENTITY_FILE', 'BUD_TERMINAL_BASE_DIR', 'BUD_ENROLLMENT_TOKEN', 'BUD_GRPC_CONTROL_URL']) assert.equal(env[key], undefined);
  }
});

test('rejects production overlap including symlink ancestors', t => {
  const home = mkdtempSync(path.join(tmpdir(), 'bud-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.bud'));
  symlinkSync(path.join(home, '.bud'), path.join(home, 'alias'));
  for (const base of [home, path.join(home, '.bud'), path.join(home, 'alias', 'new')]) {
    assert.throws(() => developmentEnvironment({ BUD_DEV_BASE_DIR: base }, 'http', home), /overlap/);
  }
});

test('shell output safely quotes custom paths and selects HTTP explicitly', () => {
  const settings = developmentEnvironment({ BUD_DEV_BASE_DIR: "/tmp/bud's $(false) dev" }, 'http', '/tmp/example-home');
  const result = spawnSync('bash', ['-c', shellEnvironment(settings) + 'printf "%s" "$BUD_BASE_DIR"'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, settings.values.BUD_BASE_DIR);
  assert.equal(settings.values.BUD_SERVER_URL, 'ws://localhost:3000/ws');
  assert.throws(() => developmentEnvironment({ BUD_DEV_SERVER_URL: 'wss://app.bud.dev/ws' }), /development/);
});
