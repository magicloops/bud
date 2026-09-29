import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Cdp } from './cdp.mjs';
import { lifecycle } from './lifecycle.mjs';
import { provenance } from './provenance.mjs';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const args = new Map(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
for (const key of args.keys()) if (!['chrome', 'seconds', 'headless', 'out', 'input', 'focus', 'background', 'hidden-only', 'background-launch', 'lifecycle', 'provenance'].includes(key)) throw new Error(`unknown_option:${key}`);
const seconds = Number(args.get('seconds') ?? 3);
if (!Number.isFinite(seconds) || seconds < 2 || seconds > 60) throw new Error('seconds_must_be_2_to_60');
const executable = args.get('chrome') ?? process.env.BUD_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headless = args.has('headless');
const focusEmulation = args.has('focus');
const background = args.has('background');
const hiddenOnly = args.has('hidden-only');
const lifecycleMode = args.has('lifecycle');
const provenanceMode = args.has('provenance');
const backgroundLaunch = args.has('background-launch') || ((lifecycleMode || provenanceMode) && process.platform === 'darwin');
if (backgroundLaunch && (process.platform !== 'darwin' || !executable.includes('.app/'))) throw new Error('background_launch_requires_macos_app');
const inputMode = args.get('input') ?? 'none';
if (!['none', 'wheel', 'bump'].includes(inputMode)) throw new Error('input_must_be_none_wheel_or_bump');
const out = args.get('out') ? resolve(args.get('out')) : await mkdtemp(join(tmpdir(), 'bud-screencast-results-'));
// Explicit output directories must already exist; never overwrite a previous run.
await chmod(out, 0o700);
await writeFile(join(out, 'run.lock'), '', { flag: 'wx', mode: 0o600 });
const profile = await mkdtemp(join(tmpdir(), 'bud-screencast-profile-'));
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const idle = await readFile(new URL('../../bud/src/browser/idle.html', import.meta.url));
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(req.url === '/idle' ? idle : fixture);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const flags = [
  ...(headless ? ['--headless=new'] : []),
  ...(background ? ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] : []),
  '--use-mock-keychain', '--password-store=basic',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--window-size=1024,768', '--no-startup-window',
];
const child = backgroundLaunch
  ? spawn('/usr/bin/open', ['-g', '-n', '-a', executable.slice(0, executable.indexOf('.app/') + 4), '--args', ...flags], { stdio: ['ignore', 'ignore', 'pipe'] })
  : spawn(executable, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
let browserPid;
let spawnError;
child.on('error', error => { spawnError = error; });
let interrupted = false;
const interrupt = () => { interrupted = true; child.kill('SIGTERM'); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let stderr = '';
let endpoint;
child.stderr.on('data', bytes => {
  if (endpoint) return;
  stderr = (stderr + bytes.toString()).slice(-65536);
  endpoint = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]{36})/)?.[1];
});
let command;
const sockets = new Set();
const report = { started_at: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, executable, headless, focus_emulation: focusEmulation || lifecycleMode || provenanceMode, provenance_mode: provenanceMode, lifecycle_mode: lifecycleMode, background_flags: background, background_launch: backgroundLaunch, hidden_only: hiddenOnly, seconds, input_mode: inputMode, source: 'isolated_cdp_probe', cases: [] };
report.source_sha256 = {};
for (const file of ['run.mjs', 'cdp.mjs', 'private-capture.mjs', 'provenance.mjs', 'fixture.html']) {
  report.source_sha256[file] = createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex');
}
const round = value => Math.round(value * 100) / 100;
function stats(values) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, p50: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95: round(sorted[Math.ceil(sorted.length * .95) - 1]), max: round(sorted.at(-1)) };
}
async function connect(maxPayload) {
  if (interrupted) throw new Error('probe_interrupted');
  const cdp = await Cdp.connect(endpoint, maxPayload);
  sockets.add(cdp);
  return cdp;
}
async function evaluate(session, expression) {
  const result = await command.call('Runtime.evaluate', { expression, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error('fixture_evaluation_failed');
  return result.result.value;
}
async function windowState(windowId, state) {
  await command.call('Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
  for (let i = 0; i < 40; i++) {
    const { bounds } = await command.call('Browser.getWindowBounds', { windowId });
    if (bounds.windowState === state) return;
    await sleep(25);
  }
  throw new Error(`window_transition_unconfirmed:${state}`);
}
async function screencast(targetId, session, name) {
  const source = await connect();
  const sourceSession = await source.attach(targetId);
  const gestures = await connect();
  const gestureSession = await gestures.attach(targetId);
  // Detaching another DevTools session can reset emulation. Apply the measured
  // viewport on this trial's source attachment and record actual geometry too.
  await source.call('Emulation.setDeviceMetricsOverride', { width: 440, height: 816, deviceScaleFactor: 1, mobile: false }, sourceSession);
  const windowBefore = await command.call('Browser.getWindowForTarget', { targetId });
  if (focusEmulation) await source.call('Emulation.setFocusEmulationEnabled', { enabled: true }, sourceSession);
  let failure;
  let disposing = false;
  source.on('ended', reason => { if (!disposing) failure ??= reason; });
  const samples = [], input = [], ack = [];
  let latest, maxPending = 0, pending = 0, previousHash, distinct = 0;
  const before = await evaluate(session, 'fixture.snapshot()');
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let measuring = true;
  source.on('event', event => {
    if (event.sessionId !== sourceSession || event.method !== 'Page.screencastFrame') return;
    if (samples.length >= 5000 || typeof event.params.data !== 'string' || event.params.data.length > 1_400_000) {
      source.close('source_bounds');
      return;
    }
    const at = performance.now(), bytes = Buffer.from(event.params.data, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (measuring) {
      if (hash !== previousHash) distinct++;
      previousHash = hash;
      latest = bytes;
      samples.push({ at_ms: round(at - started), bytes: bytes.length, metadata: event.params.metadata });
    }
    pending++;
    maxPending = Math.max(maxPending, pending);
    source.call('Page.screencastFrameAck', { sessionId: event.params.sessionId }, sourceSession)
      .then(() => { if (ack.length < 5000) ack.push(performance.now() - at); })
      .catch(error => { if (!disposing) failure ??= error.message; })
      .finally(() => pending--);
  });
  try {
    try {
      await source.call('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 440, maxHeight: 816, everyNthFrame: 1 }, sourceSession);
      while (performance.now() - started < seconds * 1000) {
        if (interrupted) throw new Error('probe_interrupted');
        await sleep(100);
        // Independent command socket; a timeout ends this trial's input. A later
        // trial starts a new connection, never replays the uncertain gesture.
        const at = performance.now();
        if (inputMode === 'wheel') {
          // Reverse each second to avoid hitting the short fixture's bottom.
          const direction = Math.floor((at - started) / 1000) % 2 ? -1 : 1;
          await gestures.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 410, y: 700, deltaX: 0, deltaY: 35 * direction }, gestureSession);
        } else if (inputMode === 'bump') {
          // Diagnostic only: separates a suspended RAF loop from paint delivery.
          await gestures.call('Runtime.evaluate', { expression: 'fixture.bump()' }, gestureSession);
        }
        if (inputMode !== 'none') input.push(performance.now() - at);
      }
    } catch (error) {
      failure = error.message;
    }
    const duration = performance.now() - started;
    measuring = false;
    await source.call('Page.stopScreencast', {}, sourceSession).catch(error => { failure ??= error.message; });
    await sleep(100); // Account for already-ACKed wheel effects before fixture read.
    const after = await evaluate(session, 'fixture.snapshot()');
    const windowAfter = await command.call('Browser.getWindowForTarget', { targetId });
    if (focusEmulation) await source.call('Emulation.setFocusEmulationEnabled', { enabled: false }, sourceSession);
    const afterDisable = await evaluate(session, 'fixture.snapshot()');
    disposing = true;
    source.close();
    gestures.close();
    await sleep(200);
    const afterDetach = await evaluate(session, 'fixture.snapshot()');
    const intervals = samples.slice(1).map((sample, i) => sample.at_ms - samples[i].at_ms);
    const result = {
      name, kind: 'screencast', started_at: startedAt, duration_ms: round(duration), before, after,
      window_before: windowBefore.bounds, window_after: windowAfter.bounds, after_disable: afterDisable, after_detach: afterDetach,
      frames: samples.length, distinct_jpegs: distinct, fps: round(samples.length / duration * 1000),
      first_frame_ms: samples[0]?.at_ms ?? null, last_frame_ms: samples.at(-1)?.at_ms ?? null,
      intervals_ms: stats(intervals), command_ack_ms: stats(input), source_ack_ms: stats(ack),
      max_pending_source_acks: maxPending, bytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
      failure: failure ?? null, samples,
    };
    if (latest) await writeFile(join(out, `${name}.jpg`), latest, { mode: 0o600 });
    report.cases.push(result);
    console.log(JSON.stringify({ case: name, fps: result.fps, frames: result.frames, command_ack_ms: result.command_ack_ms, before, after, failure: result.failure }));
  } finally { source.close(); gestures.close(); }
}
async function screenshots(targetId, session, name) {
  const source = await connect(24 * 1024 * 1024);
  try {
    const sourceSession = await source.attach(targetId);
    await source.call('Emulation.setDeviceMetricsOverride', { width: 440, height: 816, deviceScaleFactor: 1, mobile: false }, sourceSession);
    const timings = [];
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      const result = await source.call('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false, clip: { x: 0, y: await evaluate(session, 'scrollY'), width: 440, height: 816, scale: 1 } }, sourceSession);
      timings.push(performance.now() - at);
      if (i === 0) await writeFile(join(out, `${name}.jpg`), Buffer.from(result.data, 'base64'), { mode: 0o600 });
    }
    report.cases.push({ name, kind: 'screenshot_rpc_only', timings_ms: stats(timings) });
  } finally { source.close(); }
}

try {
  for (let i = 0; !endpoint && i < 150; i++) {
    if (spawnError) throw new Error('chrome_spawn_failed');
    if (child.exitCode !== null && (!backgroundLaunch || child.exitCode !== 0)) throw new Error('chrome_exited');
    if (backgroundLaunch) {
      const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, path] = active.trim().split('\n');
      if (/^\d+$/.test(port) && /^\/devtools\/browser\/[0-9a-f-]{36}$/.test(path)) endpoint = `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(100);
  }
  if (!endpoint) throw new Error('chrome_discovery_timeout');
  command = await connect(24 * 1024 * 1024);
  report.browser = await command.call('Browser.getVersion');
  browserPid = (await command.call('SystemInfo.getProcessInfo')).processInfo.find(info => info.type === 'browser')?.id;
  report.browser_pid = browserPid;
  const protocol = await fetch(new URL('/json/protocol', endpoint.replace('ws:', 'http:')), { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const pageProtocol = protocol.domains.find(domain => domain.domain === 'Page');
  report.screencast_parameters = pageProtocol.commands.find(method => method.name === 'startScreencast')?.parameters.map(parameter => parameter.name);
  report.focus_emulation_supported = protocol.domains.find(domain => domain.domain === 'Emulation')?.commands.some(method => method.name === 'setFocusEmulationEnabled');
  const pages = [];
  for (const label of ['A', 'B']) {
    const { targetId } = await command.call('Target.createTarget', { url: `${origin}/?document=${label}`, background: true });
    const session = await command.attach(targetId);
    await command.call('Emulation.setDeviceMetricsOverride', { width: 440, height: 816, deviceScaleFactor: 1, mobile: false }, session);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(session, 'Boolean(window.fixture)')) break;
      await sleep(25);
    }
    pages.push({ targetId, session });
  }
  const { targetId: idleId } = await command.call('Target.createTarget', { url: `${origin}/idle`, background: true });
  const windowIds = [];
  for (const id of [...pages.map(page => page.targetId), idleId]) windowIds.push((await command.call('Browser.getWindowForTarget', { targetId: id })).windowId);
  if (new Set(windowIds).size !== 1) throw new Error('fixture_targets_not_same_window');
  const windowId = windowIds[0];
  const a = pages[0], b = pages[1];
  if (provenanceMode) {
    await command.call('Target.activateTarget', { targetId: idleId });
    await windowState(windowId, 'minimized');
    report.provenance = [];
    await provenance({ pages, command, connect, evaluate, origin, idleId, results: report.provenance });
  } else if (lifecycleMode) {
    await command.call('Target.activateTarget', { targetId: idleId });
    await windowState(windowId, 'minimized');
    await sleep(300);
    report.lifecycle = [];
    await lifecycle({ pages, command, connect, evaluate, origin, results: report.lifecycle });
  } else if (hiddenOnly) {
    await command.call('Target.activateTarget', { targetId: idleId });
    await windowState(windowId, 'minimized');
    await sleep(300);
    await screencast(a.targetId, a.session, 'cold_hidden_A');
    await screencast(b.targetId, b.session, 'cold_hidden_B');
  } else {
  await windowState(windowId, 'normal');
  await command.call('Target.activateTarget', { targetId: a.targetId });
  await sleep(300);
  await screencast(a.targetId, a.session, 'selected_restored');
  await screenshots(a.targetId, a.session, 'selected_restored_screenshot');
  await windowState(windowId, 'minimized');
  await sleep(300);
  await screencast(a.targetId, a.session, 'selected_minimized');
  await windowState(windowId, 'normal');
  await command.call('Target.activateTarget', { targetId: idleId });
  await sleep(300);
  await screencast(a.targetId, a.session, 'idle_selected_restored_A');
  await windowState(windowId, 'minimized');
  await sleep(300);
  await screencast(a.targetId, a.session, 'idle_selected_minimized_A');
  await screencast(b.targetId, b.session, 'idle_selected_minimized_B');
  await screenshots(a.targetId, a.session, 'idle_selected_minimized_A_screenshot');
  await windowState(windowId, 'normal');
  await command.call('Target.activateTarget', { targetId: a.targetId });
  await sleep(300);
  await screencast(a.targetId, a.session, 'selected_restored_again');
  }
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  if (command) await command.call('Browser.close', {}, undefined, 2000).catch(() => {});
  for (const socket of sockets) socket.close();
  if (backgroundLaunch && !browserPid && !spawnError) {
    report.retained_profile = profile;
    report.failure ??= 'background_browser_identity_unconfirmed';
    process.exitCode = 1;
  }
  if (backgroundLaunch && browserPid) {
    await sleep(1000);
    // This prototype has no native process handle. Do not signal a bare PID;
    // keep the disposable profile if graceful CDP shutdown was not confirmed.
    const argv = await exec('/bin/ps', ['-p', String(browserPid), '-o', 'command=']).then(r => r.stdout).catch(error => error.code === 1 ? '' : null);
    if (argv === null || argv.includes(`--user-data-dir=${profile}`)) {
      report.failure ??= 'background_browser_exit_unconfirmed';
      report.retained_profile = profile;
      process.exitCode = 1;
    }
  }
  if (child.exitCode === null && !spawnError) {
    await Promise.race([once(child, 'exit'), sleep(2000)]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (!report.retained_profile) await rm(profile, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  report.outcome = report.failure ? 'probe_error'
    : report.cases.some(item => item.failure || (item.kind === 'screencast' && (item.frames < 2 || item.last_frame_ms < item.duration_ms * 0.75)))
      ? 'capture_gate_failed' : 'capture_gate_requires_further_validation';
  if (report.outcome === 'capture_gate_failed') process.exitCode = 2;
  await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(JSON.stringify({ results: join(out, 'results.json'), outcome: report.outcome, failure: report.failure ?? null }));
}
