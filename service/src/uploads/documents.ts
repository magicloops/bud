import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileError } from './contracts.js';
import { originalBytes, fileObjects, type FileObjects } from './objects.js';
import { files, type FileRepository } from './repository.js';
import type { UserFile } from './schema.js';

type Document = NonNullable<UserFile['document']>;
type PageImage = { image: string; page_count: number };
let parsing = 0;
export async function parseDocument(bytes: Buffer, name: string, mime: string, page?: number): Promise<Document | PageImage> {
  if (parsing >= 2) throw new FileError('file_reader_busy', 429);
  parsing++;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'bud-document-'));
    const path = join(directory, 'original');
    await writeFile(path, bytes, { mode: 0o600 });
    return await new Promise((resolve, reject) => {
      const child = fork(new URL('./document-worker.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--max-old-space-size=192'],
        env: { PATH: process.env.PATH },
      });
      let result: Document | PageImage | undefined;
      let failure: Error | undefined;
      const timer = setTimeout(() => { failure = new FileError('file_read_timeout'); child.kill('SIGKILL'); }, 20_000);
      child.on('error', error => { failure = error; });
      child.once('message', (value: Document | PageImage | { error: string }) => {
        if ('error' in value) failure = new FileError(value.error);
        else result = value;
        child.kill('SIGKILL');
      });
      child.once('close', () => { clearTimeout(timer); if (failure || !result) reject(failure ?? new FileError('file_unreadable')); else resolve(result); });
      child.send({ path, name, mime, page });
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    parsing--;
  }
}

export async function readDocument(owner: string, id: string, page?: number,
  repository: FileRepository = files, objects: () => FileObjects = fileObjects) {
  const file = await repository.owned(owner, id);
  if (!page && file.document) return file.document;
  const bytes = await originalBytes(objects(), id, file.sizeBytes, file.sha256!);
  const result = await parseDocument(bytes, file.name, file.mimeType, page);
  await repository.owned(owner, id); // A deleted file cannot return newly derived content.
  if ('pages' in result) await repository.saveDocument(owner, id, result);
  return result;
}
