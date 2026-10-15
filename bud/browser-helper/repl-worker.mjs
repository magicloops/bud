import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// Trusted-code worker. Private stdio is a lifecycle boundary, not a sandbox.
import { start } from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createInterface } from 'node:readline';
import { formatWithOptions } from 'node:util';
import { createBrowser } from './repl-api.mjs';
import { artifacts, bounded, CAPTURE_LIMIT } from './repl-artifacts.mjs';

// Use Node's evaluator for module loading and top-level await, but never its
// interactive output. Completion values join our cell-owned output after draining.
const evaluator = start({ input: new PassThrough(),
  output: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  terminal: false, prompt: '', useGlobal: true });
const context = new AsyncLocalStorage();
const writeFrame = process.stdout.write.bind(process.stdout);
const send = value => writeFrame(JSON.stringify(value) + '\n');
const pending = new Map();
let serial = 0;
let active;
const DEFAULT_TEXT_LIMIT = 8 * 1024;
const MAX_TEXT_LIMIT = 32 * 1024;
function cellContext() {
  const cell = context.getStore();
  if (!cell || cell !== active || cell.closed) throw Error('browser_repl_inactive_cell');
  return cell;
}
const inspectOptions = Object.freeze({ depth: 5, maxArrayLength: 100,
  maxStringLength: 10000, customInspect: false, getters: false, colors: false });
function output(...values) {
  const cell = cellContext();
  let text;
  try {
    text = formatWithOptions(inspectOptions, ...values.map(value =>
      ArrayBuffer.isView(value) || value instanceof ArrayBuffer
        ? `[Binary value: ${value.byteLength} bytes; use repl.emitImage for screenshots]`
        : value));
  } catch {
    // Display failure must not turn completed browser effects into a retry signal.
    text = '[Value could not be displayed; select concrete fields from retained data]';
  }
  const line = text + '\n';
  cell.capture += bounded(line, CAPTURE_LIMIT - Buffer.byteLength(cell.capture));
  cell.capture_truncated ||= Buffer.byteLength(line) + cell.capture_bytes > CAPTURE_LIMIT;
  cell.capture_bytes += Buffer.byteLength(line);
  // Successful execution is independent of display size. Preserve preceding
  // writes and label a UTF-8-safe excerpt; never pretend clipped JSON is complete.
  const remaining = cell.text_limit - Buffer.byteLength(cell.text);
  if (!cell.truncated && Buffer.byteLength(line) <= remaining) cell.text += line;
  else if (!cell.truncated) {
    cell.truncated = true;
    const start = '[INCOMPLETE OUTPUT EXCERPT — not complete JSON]\n';
    const end = '\n[Output omitted; select retained data or a bounded artifact excerpt. Do not reprint the whole artifact or repeat actions.]\n';
    if (remaining >= Buffer.byteLength(start + end))
      cell.text += start + bounded(line, remaining - Buffer.byteLength(start + end)) + end;
  }
}
function operation(command) {
  const cell = cellContext();
  const id = ++serial;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { cell, resolve, reject });
    send({ type: 'operation', cell_id: cell.id, operation_id: id, command });
  });
  // Track even unawaited calls and rejection, without creating an unhandled
  // rejection merely because user code omitted await.
  cell.operations.add(promise);
  promise.then(() => cell.operations.delete(promise), error => {
    cell.operations.delete(promise);
    cell.operationError ??= error.message;
  });
  return promise;
}
const files = artifacts(process.argv[2], cellContext);
const api = createBrowser(operation, () => {
  const cell = cellContext();
  return cell.text_limit - Buffer.byteLength(cell.text);
});
globalThis.repl = Object.freeze({ files,
  attachFile(grant, target_id, reference, observation_id) {
    const cell = cellContext();
    const task = (async () => {
      const endpoint = new URL(grant.endpoint);
      if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname))) ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          !/^[A-Za-z0-9_-]{43}$/.test(grant.ticket) || !/^[^/\\\x00-\x1f]{1,240}$/.test(grant.name) || ['.','..'].includes(grant.name) ||
          !/^[-\w.+]+\/[-\w.+]+$/.test(grant.mime_type) || grant.mime_type.length > 200 ||
          !Number.isInteger(grant.size_bytes) || grant.size_bytes < 1 || grant.size_bytes > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(grant.sha256))
        throw Error('browser_invalid_file_grant');
      const directory = await mkdtemp(join(process.argv[2], 'upload-'));
      try {
        const path = join(directory, grant.name), file = await open(path, 'wx', 0o600);
        try {
          const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${grant.ticket}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
          if (!response.ok || !response.body) throw Error('browser_file_unavailable');
          let received = 0; const hash = createHash('sha256');
          for await (const chunk of response.body) {
            cellContext(); received += chunk.byteLength;
            if (received > grant.size_bytes) throw Error('browser_file_integrity_failed');
            hash.update(chunk); await file.writeFile(chunk);
          }
          if (received !== grant.size_bytes || hash.digest('hex') !== grant.sha256) throw Error('browser_file_integrity_failed');
        } finally { await file.close(); }
        cellContext();
        return await operation({ action: 'repl', operation: 'set_files', target_id, reference, observation_id, paths: [path], mime_types: [grant.mime_type] });
      } finally { await rm(directory, { recursive: true, force: true }); }
    })();
    cell.operations.add(task);
    task.then(() => cell.operations.delete(task), () => { cell.operations.delete(task); cell.operationError ??= 'browser_file_upload_failed'; });
    return task;
  },
  setOutputBudget(bytes) {
    const cell = cellContext();
    if (!Number.isInteger(bytes) || bytes < 1024 || bytes > MAX_TEXT_LIMIT)
      throw Error('browser_output_budget_invalid');
    if (cell.capture_bytes) throw Error('browser_output_budget_already_used');
    cell.text_limit = bytes;
  },
  async emitImage(bytes) {
    const cell = cellContext();
    const index = cell.image_count++;
    if (index >= 2) throw Error('browser_image_limit');
    const result = await api.emitImage(bytes, index);
    cell.images.push(result.image_artifact);
  },
});
globalThis.browser = api.browser;
for (const name of ['log', 'info', 'warn', 'error', 'debug', 'dir']) {
  console[name] = (...args) => output(...args);
}
process.stdout.write = (chunk, encoding, callback) => {
  output(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
  if (typeof encoding === 'function') encoding(); else callback?.();
  return true;
};
process.stderr.write = process.stdout.write;

async function execute(message) {
  const cell = { id: message.cell_id, text_limit: DEFAULT_TEXT_LIMIT, text: '', capture: '', capture_bytes: 0, capture_truncated: false, images: [], image_count: 0, truncated: false, operations: new Set(), closed: false };
  active = cell;
  let error;
  let completion;
  try {
    await context.run(cell, async () => {
      // Node's default REPL routes thrown exceptions to its domain rather than
      // the eval callback. Isolate that version-pinned behavior here; tests cover
      // sync throws, rejected await, imports, lexical bindings and late callbacks.
      await new Promise((resolve) => {
        let settled = false;
        const finish = (failure, value) => {
          if (settled) return;
          settled = true;
          evaluator._domain.removeListener('error', onError);
          if (failure) error = bounded(String(failure.stack ?? failure), 2048);
          else completion = value;
          resolve();
        };
        const onError = failure => {
          if (context.getStore() === cell) finish(failure);
        };
        evaluator._domain.on('error', onError);
        evaluator.eval(message.code + '\n', evaluator.context, 'bud-repl', finish);
      });
      while (cell.operations.size) await Promise.allSettled([...cell.operations]);
      error ??= cell.operationError;
      if (!error && completion !== undefined) output(completion);
    });
    error ??= cell.operationError;
    if (cell.truncated) cell.output_artifact = context.run(cell, () => ({ ...files.write(cell.capture), truncated: cell.capture_truncated }));
  } catch (failure) {
    error = bounded(String(failure.message), 2048);
  } finally {
    cell.closed = true;
    active = undefined;
  }
  send({ type: 'result', cell_id: cell.id, ok: !error, error,
    ...(message.trace === true ? { _trace_output: { content: cell.capture, bytes: cell.capture_bytes, truncated: cell.capture_truncated, text_limit: cell.text_limit, formatter: inspectOptions } } : {}),
    text: cell.text || (cell.truncated ? '(output omitted; inspect output_artifact or select from retained variables; do not repeat browser actions)' : '(no output)'), truncated: cell.truncated, images: cell.images, output_artifact: cell.output_artifact });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (Buffer.byteLength(line) > 16 * 1024 * 1024) process.exit(1);
  let message;
  try { message = JSON.parse(line); } catch { process.exit(1); }
  if (message.type === 'execute') {
    if (active || typeof message.cell_id !== 'string' || typeof message.code !== 'string'
        || Buffer.byteLength(message.code) > 64 * 1024) process.exit(1);
    void execute(message).catch(() => process.exit(1));
  } else if (message.type === 'operation_result') {
    const call = pending.get(message.operation_id);
    if (!call || call.cell.id !== message.cell_id) process.exit(1);
    pending.delete(message.operation_id);
    if (message.ok) call.resolve(message.data);
    else call.reject(Error(message.error ?? 'browser_outcome_unknown'));
  } else process.exit(1);
}
process.exit(0);
