import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { BrowserAgentContext } from '../agent/browser-tool-executor.js';
import { agentFile } from './agent.js';
import { FileError } from './contracts.js';
import { fileObjects, originalBytes } from './objects.js';

type Grant = { context: BrowserAgentContext; id: string; expires: number; authorized: () => Promise<boolean> };
const grants = new Map<string, Grant>();
/** Per-dispatch bearer grants never enter model arguments or durable receipts. */
export async function browserFiles(context: BrowserAgentContext, ids: string[], authorized: () => Promise<boolean>) {
  for (const [ticket, grant] of grants) if (grant.expires <= Date.now()) grants.delete(ticket);
  if (grants.size + ids.length > 100) throw new FileError('file_transfer_busy', 429);
  const entries: Record<string, unknown> = {}, tickets: string[] = [];
  try {
    for (const id of ids) {
      const file = await agentFile(context, id);
      const ticket = randomBytes(32).toString('base64url'); tickets.push(ticket);
      grants.set(ticket, { context, id, expires: Date.now() + 30_000, authorized });
      entries[id] = { endpoint: new URL('/api/uploads/browser-transfer', config.betterAuthUrl).href,
        ticket, name: file.name, mime_type: file.mimeType, size_bytes: file.sizeBytes, sha256: file.sha256 };
    }
  } catch (error) { for (const ticket of tickets) grants.delete(ticket); throw error; }
  return {
    // The closure holds grants; printing its function does not reveal credentials.
    prefix: `var uploads = ((grants) => Object.freeze({attach: async (target_id, reference, observation_id, file_id) => { if (!Object.hasOwn(grants,file_id)) throw Error('browser_file_not_selected'); return repl.attachFile(grants[file_id],target_id,reference,observation_id); }}))(${JSON.stringify(entries)});\n`,
    dispose() { for (const ticket of tickets) grants.delete(ticket); },
  };
}
export async function registerBrowserFileTransfers(server: FastifyInstance) {
  server.get('/api/uploads/browser-transfer', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const ticket = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const grant = grants.get(ticket); grants.delete(ticket);
    if (!grant || grant.expires <= Date.now()) return reply.code(403).send({ error: 'file_transfer_expired' });
    try {
      if (!await grant.authorized()) throw new FileError('file_transfer_revoked', 403);
      const file = await agentFile(grant.context, grant.id);
      const bytes = await originalBytes(fileObjects(), file.id, file.sizeBytes, file.sha256!);
      await agentFile(grant.context, grant.id);
      if (grant.expires <= Date.now() || !await grant.authorized()) throw new FileError('file_transfer_revoked', 403);
      return reply.type('application/octet-stream').send(bytes);
    } catch { return reply.code(403).send({ error: 'file_transfer_revoked' }); }
  });
}
