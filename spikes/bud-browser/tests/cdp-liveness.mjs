// Disposable independent CDP probe: no Rust host, relay, DB or real accounts.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../service/package.json', import.meta.url));
const { WebSocket } = require('ws');
const executable = process.env.BUD_BROWSER_EXECUTABLE;
if (!executable) throw Error('Set BUD_BROWSER_EXECUTABLE to the comparison browser');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const owned = new Set();
let earlyCaptureRejections = 0;

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'bud-browser-node-probe-'));
  const child = spawn(executable, [
    '--headless=new', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--use-mock-keychain', '--password-store=basic', 'about:blank',
  ], { stdio: 'ignore' });
  const state = { dir, child, socket: null, spawnFailed: false };
  owned.add(state);
  state.exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', () => { state.spawnFailed = true; resolve(); });
  });
  let endpoint;
  for (let i = 0; i < 600; i++) {
    if (state.spawnFailed || child.exitCode !== null) throw Error('child_exit');
    const text = await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const match = text.match(/^(\d+)\n(\/devtools\/browser\/[a-f0-9-]{36})$/);
    if (match) { endpoint = `ws://127.0.0.1:${match[1]}${match[2]}`; break; }
    await sleep(25);
  }
  if (!endpoint) throw Error('discovery_timeout');
  const socket = new WebSocket(endpoint, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 });
  state.socket = socket;
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let id = 0;
  state.call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const requestID = ++id;
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(Error(`timeout pid=${child.pid} method=${method} id=${requestID}`));
    }, 10000);
    function receive(text) {
      const value = JSON.parse(text);
      if (value.id !== requestID) return;
      clearTimeout(timer);
      socket.off('message', receive);
      if (value.error) reject(Error(`rejected ${method}`));
      else resolve(value.result);
    }
    socket.on('message', receive);
    socket.send(JSON.stringify({ id: requestID, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return state;
}

async function close(state) {
  state.socket?.terminate();
  state.child.kill('SIGKILL');
  await state.exited;
  await rm(state.dir, { recursive: true, force: true });
  owned.delete(state);
}

try {
  for (let wave = 1; wave <= 50; wave++) {
    const jobs = [0, 1, 2, 3].map(async (slot) => {
      const browser = await launch();
      for (let i = 0; i < 8; i++) {
        const { targetInfos } = await browser.call('Target.getTargets');
        if (i === 0 && slot % 2 === 0) {
          const { sessionId } = await browser.call('Target.attachToTarget', {
            targetId: targetInfos.find((target) => target.type === 'page').targetId, flatten: true,
          });
          await browser.call('Page.enable', {}, sessionId);
          await browser.call('Page.navigate', {
            url: 'data:text/html,<h1>Fixture</h1><input autofocus>',
          }, sessionId);
          await browser.call('Page.bringToFront', {}, sessionId);
          try {
            await browser.call('Page.captureScreenshot', { format: 'jpeg', quality: 65 }, sessionId);
          } catch (error) {
            // This measures liveness, not rendering readiness. A definitive
            // rejection is responsive; unknown/time-out outcomes still fail.
            // Rust's separate fixture tests validate successful capture.
            if (error.message !== 'rejected Page.captureScreenshot') throw error;
            earlyCaptureRejections++;
          }
        }
        await sleep(20);
      }
      await close(browser);
    });
    const results = await Promise.allSettled(jobs);
    const failed = results.find((result) => result.status === 'rejected');
    console.log(`node-probe wave=${wave} ok=${!failed} early_capture_rejections=${earlyCaptureRejections}`);
    if (failed) throw failed.reason;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  const pid = Number(error.message.match(/pid=(\d+)/)?.[1]);
  if (process.platform === 'darwin' && process.argv.includes('--sample-on-failure') &&
      [...owned].some((state) => state.child.pid === pid)) {
    const path = join(tmpdir(), `bud-browser-node-${pid}.sample.txt`);
    await new Promise((resolve) => {
      const task = spawn('/usr/bin/sample', [String(pid), '1', '1', '-file', path], { stdio: 'ignore' });
      task.once('exit', resolve);
      task.once('error', resolve);
    });
    console.log(`sample=${path}`);
  }
} finally {
  await Promise.allSettled([...owned].map(close));
}
