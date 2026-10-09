import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve existing ancestors too: a not-yet-created base can be under a symlink.
export function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
  }
}

export function developmentEnvironment(env, mode = 'https', home = homedir()) {
  if (!['http', 'https'].includes(mode)) throw new Error('Use http or https');
  const base = canonicalPath(env.BUD_DEV_BASE_DIR || path.join(home, '.bud-dev'));
  const production = canonicalPath(path.join(home, '.bud'));
  if (base === production || base.startsWith(production + path.sep) || production.startsWith(base + path.sep)) {
    throw new Error('Development base must not overlap ~/.bud');
  }
  const server = env.BUD_DEV_SERVER_URL || (mode === 'https' ? 'wss://localhost:3443/ws' : 'ws://localhost:3000/ws');
  const url = new URL(server);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || ['app.bud.dev', 'api.bud.dev'].includes(url.hostname)) {
    throw new Error('BUD_DEV_SERVER_URL must be a development WebSocket endpoint without credentials');
  }
  return {
    unset: ['BUD_MANAGED_LAUNCH', 'BUD_IDENTITY_FILE', 'BUD_TERMINAL_BASE_DIR', 'BUD_LOCAL', 'BUD_ENROLLMENT_TOKEN', 'BUD_CLAIM_ID',
      'BUD_GRPC_CONTROL_URL', 'BUD_GRPC_DATA_URL', 'BUD_UPGRADE_BASE_URL',
      'BUD_BROWSER_EXECUTABLE', 'BUD_BROWSER_HELPER', 'BUD_BROWSER_NODE'],
    values: {
      BUD_BASE_DIR: base, BUD_SERVER_URL: server, BUD_DEVICE_NAME: env.BUD_DEV_DEVICE_NAME || 'bud-dev',
      BUD_DEFAULT_CWD: env.BUD_DEV_DEFAULT_CWD || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      BUD_TERMINAL_ENABLED: 'true',
    },
  };
}

export function shellEnvironment(settings) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return `unset ${settings.unset.join(' ')}\n` + Object.entries(settings.values)
    .map(([key, value]) => `export ${key}=${quote(value)}`).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(shellEnvironment(developmentEnvironment(process.env, process.argv[2]))); }
  catch (error) { console.error(`Bud development setup: ${error.message}`); process.exitCode = 1; }
}
