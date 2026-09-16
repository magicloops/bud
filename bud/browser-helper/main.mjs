// Private, serial stdio protocol. Never expose an evaluate/CDP surface to agents.
import { createInterface } from 'node:readline';
import { Engine } from './engine.mjs';
let engine;
for await (const line of createInterface({ input: process.stdin })) {
  if (Buffer.byteLength(line) > 32 * 1024) process.exit(1);
  try {
    const command = JSON.parse(line);
    if (!engine) {
      const url = new URL(command.endpoint);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('browser_invalid_endpoint');
      engine = await Engine.connect(command.endpoint);
      process.stdout.write('{"ok":true,"data":{}}\n');
    } else {
      const data = await engine.execute(command);
      process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
    }
  } catch (error) {
    const code = /^browser_[a-z_]+$/.test(error.message) ? error.message : 'browser_outcome_unknown';
    process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
  }
}
process.exit(0);
