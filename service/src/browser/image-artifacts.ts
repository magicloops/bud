import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { pool } from '../db/client.js';
import type { CanonicalContentBlock, CanonicalMessage } from '../llm/types.js';
import type { ProviderInvocationContext } from '../llm/provider.js';

const directory = resolve(process.env.BUD_BROWSER_ARTIFACT_DIR ?? '.bud-data/browser-images');
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX = 1_400_000;
export type ImageArtifact = {
  id: string; owner: string; thread: string; bud: string; call: string;
  session: string; generation: string; epoch: number; target: string; document: string;
  expires_at: number; image: string; mime_type: 'image/png' | 'image/jpeg';
};
export class ImageArtifacts {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly path = directory) {}
  put(value: Omit<ImageArtifact, 'id' | 'expires_at'>) {
    const operation = this.writing.then(() => this.write(value));
    this.writing = operation.catch(() => {});
    return operation;
  }
  private async write(value: Omit<ImageArtifact, 'id' | 'expires_at'>) {
    if (value.image.length > MAX) throw Error('browser_image_limit');
    await mkdir(this.path, { recursive: true, mode: 0o700 });
    const names = await readdir(this.path);
    // Bound storage and clean expired images, without retaining a second index.
    let kept = 0;
    for (const name of names) {
      if (!/^\d+-[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name)) continue;
      if (Number(name.split('-')[0]) < Date.now()) await unlink(join(this.path, name)).catch(() => {});
      else kept++;
    }
    if (kept >= 128) throw Error('browser_image_capacity');
    const expires_at = Date.now() + TTL;
    const id = `${expires_at}-${ulid()}`;
    const artifact = { ...value, id, expires_at };
    await writeFile(join(this.path, `${id}.json`), JSON.stringify(artifact), { flag: 'wx', mode: 0o600 });
    return { id, mime_type: value.mime_type, expires_at: new Date(expires_at).toISOString() };
  }
  async get(id: string, owner: string, thread: string, call?: string): Promise<ImageArtifact | null> {
    if (!/^\d+-[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || Number(id.split('-')[0]) <= Date.now()) return null;
    try {
      const value: ImageArtifact = JSON.parse(await readFile(join(this.path, `${id}.json`), 'utf8'));
      if (value.owner !== owner || value.thread !== thread || (call && value.call !== call) || value.image.length > MAX || value.expires_at <= Date.now()) return null;
      return value;
    } catch { return null; }
  }
}
export const browserImages = new ImageArtifacts();

// Hydrate immediately before the provider call, after diagnostic recording.
// Durable transcript/ledger retains only immutable artifact references.
export async function hydrateBrowserImages(messages: CanonicalMessage[], context: ProviderInvocationContext | undefined, vision: boolean,
  store = browserImages, authorize = async (owner: string, thread: string, bud: string) => {
    const result = await pool.query(`select t.thread_id from thread t join bud b on b.bud_id=t.bud_id
      where t.thread_id=$1 and t.bud_id=$2 and t.created_by_user_id=$3 and b.created_by_user_id=$3 and t.deleted_at is null`, [thread, bud, owner]);
    return Boolean(result.rowCount);
  }): Promise<CanonicalMessage[]> {
  // Limit provider payloads to the eight newest requested screenshots.
  const selected = new Set<CanonicalContentBlock>();
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of [...message.content].reverse()) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      try {
        const payload = JSON.parse(block.content);
        if (selected.size < 8 && payload?.tool === 'browser_observe' && payload?.ok === true && typeof payload?.data?.image_artifact?.id === 'string') selected.add(block);
      } catch { /* Ordinary text tool output. */ }
    }
  }
  let owned: boolean | undefined;
  const result: CanonicalMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) { result.push(message); continue; }
    const content: CanonicalContentBlock[] = [...message.content];
    for (const block of message.content) {
      if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
      let payload;
      try { payload = JSON.parse(block.content); } catch { continue; }
      const id = payload?.tool === 'browser_observe' && payload?.ok === true && payload?.data?.image_artifact?.id;
      if (typeof id !== 'string') continue;
      let image: ImageArtifact | null = null;
      if (context?.ownerUserId && vision && selected.has(block)) {
        owned ??= await authorize(context.ownerUserId, context.threadId, context.budId);
        if (owned) image = await store.get(id, context.ownerUserId, context.threadId, block.tool_use_id);
      }
      content.push({ type:'text', text: image ? `Screenshot from browser tool call ${block.tool_use_id}:` : `Screenshot from browser tool call ${block.tool_use_id} is unavailable (expired, unauthorized, outside the eight-image history budget, or this model lacks image support).` });
      if (image) content.push({ type:'image', source:{ type:'base64', media_type:image.mime_type, data:image.image } });
    }
    result.push({ ...message, content });
  }
  return result;
}
