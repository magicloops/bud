import { readFileSync, writeFileSync, unlinkSync, constants, openSync, closeSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const CAPTURE_LIMIT = 1024 * 1024;
export function bounded(text, bytes) {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString();
}
// Directory belongs to the daemon's worker lifetime. At most 16 one-MiB files.
export function artifacts(directory, check) {
  const retained = new Map();
  return Object.freeze({
    write(value) {
      check();
      const source = typeof value === 'string' ? value : JSON.stringify(value);
      const text = bounded(source, CAPTURE_LIMIT);
      const name = randomUUID() + '.txt';
      while (retained.size >= 16) {
        const oldest = retained.keys().next().value;
        unlinkSync(join(directory, oldest)); retained.delete(oldest);
      }
      writeFileSync(join(directory, name), text, { mode: 0o600, flag: 'wx' });
      const result = { path: name, bytes: Buffer.byteLength(text), truncated: Buffer.byteLength(source) > CAPTURE_LIMIT };
      retained.set(name, result); return result;
    },
    read(name) {
      check();
      if (!retained.has(name)) throw Error('browser_artifact_unavailable');
      const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > CAPTURE_LIMIT) throw Error('browser_artifact_limit');
        return readFileSync(fd, 'utf8');
      } finally { closeSync(fd); }
    },
  });
}
