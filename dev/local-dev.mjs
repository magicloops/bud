#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function developmentTrustedOrigins(appOrigin) {
  return [...new Set([appOrigin, 'https://localhost:3443', 'http://localhost:5173', 'http://localhost:3000'])].join(',');
}

export function profileEnvironment(profile, env) {
  if (!['http', 'https', 'ngrok'].includes(profile)) throw new Error('Choose http, https or ngrok.');
  const origin = profile === 'http' ? 'http://localhost:5173'
    : profile === 'https' ? 'https://localhost:3443' : env.BUD_DEV_NGROK_URL;
  if (!origin) throw new Error('Set BUD_DEV_NGROK_URL in dev/.env.local or your shell.');
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (profile === 'ngrok' && url.protocol !== 'https:')) throw new Error('Ngrok URL must be an HTTPS origin without credentials, path or query.');
  const appOrigin = url.origin;
  return {
    ...env,
    BUD_DEV_HTTPS_ORIGIN: appOrigin,
    APP_BASE_URL: appOrigin,
    BETTER_AUTH_URL: appOrigin,
    API_AUDIENCE: `${appOrigin}/api`,
    BETTER_AUTH_TRUSTED_ORIGINS: developmentTrustedOrigins(appOrigin),
    HOST: '127.0.0.1', PORT: '3000',
    VITE_API_BASE_URL: profile === 'http' ? 'http://localhost:3000' : '',
    VITE_API_PROXY_TARGET: 'http://localhost:3000',
    ...(profile === 'http' ? {
      PROXY_BASE_DOMAIN: env.BUD_DEV_PROXY_BASE_DOMAIN || 'bud-proxy.localhost',
      PROXY_PUBLIC_SCHEME: env.BUD_DEV_PROXY_BASE_DOMAIN ? 'https' : 'http',
      PROXY_PUBLIC_PORT: env.BUD_DEV_PROXY_PUBLIC_PORT ?? (env.BUD_DEV_PROXY_BASE_DOMAIN ? '' : '3000'),
      PROXY_VIEWER_COOKIE_NAME: env.BUD_DEV_PROXY_BASE_DOMAIN ? '__Host-bud_proxy_viewer' : 'bud_proxy_viewer',
    } : {}),
  };
}

async function portBusy(port) {
  return new Promise(resolveBusy => {
    const socket = net.connect({ host: 'localhost', port });
    socket.setTimeout(500);
    const finish = value => { socket.destroy(); resolveBusy(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function existingTunnel(origin) {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error('Ngrok inspector unavailable');
    const data = await response.json();
    const match = data.tunnels?.find(tunnel => tunnel.public_url === origin);
    if (!match) throw new Error('Ngrok is running with another URL. Stop it or update BUD_DEV_NGROK_URL.');
    const target = new URL(match.config.addr);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '3443' || target.protocol !== 'https:') {
      throw new Error('Existing ngrok tunnel must forward to https://localhost:3443.');
    }
    return true;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'TimeoutError') return false;
    throw error;
  }
}

async function main() {
  const config = resolve(root, 'dev/.env.local');
  if (existsSync(config)) process.loadEnvFile(config);
  const profile = process.argv[2] ?? 'http';
  const env = profileEnvironment(profile, process.env);
  if (process.argv.includes('--print-env')) {
    for (const key of ['APP_BASE_URL', 'BETTER_AUTH_URL', 'API_AUDIENCE', 'BETTER_AUTH_TRUSTED_ORIGINS', 'VITE_API_BASE_URL']) console.log(`${key}=${env[key]}`);
    return;
  }
  for (const port of profile === 'http' ? [3000, 5173] : [3000, 5173, 3443]) {
    if (await portBusy(port)) throw new Error(`Port ${port} is occupied. Stop the current dev launcher before switching profiles.`);
  }
  const reuseNgrok = profile === 'ngrok' && await existingTunnel(env.APP_BASE_URL);
  const children = [];
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
  };
  const launch = (command, args, cwd = root) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: true });
    children.push(child);
    child.once('error', error => { console.error(error.message); stop(1); });
    child.once('exit', code => { if (!stopping) stop(code || 1); });
  };
  process.once('SIGINT', () => stop(130));
  process.once('SIGTERM', () => stop(143));
  console.log(`[dev:${profile}] App/OAuth origin: ${env.APP_BASE_URL}`);
  if (profile === 'http') {
    launch('pnpm', ['dev'], resolve(root, 'service'));
    launch('pnpm', ['dev', '--host', 'localhost', '--port', '5173', '--strictPort'], resolve(root, 'web'));
  } else {
    if (profile === 'ngrok') {
      if (reuseNgrok) console.log('[dev:ngrok] Reusing existing tunnel; it will remain running on exit.');
      else launch('ngrok', ['http', 'https://localhost:3443', `--url=${env.APP_BASE_URL}`, '--host-header=localhost:3443']);
    }
    launch(process.execPath, ['dev/local-https.mjs', 'start', ...process.argv.slice(3)]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`[dev] ${error.message}`); process.exitCode = 1; });
}
