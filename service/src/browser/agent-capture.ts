import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireViewer, getAuthorizedThread } from '../auth/session.js';
import type { BrowserCommand, BrowserCarrier } from './transport.js';
import { BrowserRepository } from './repository.js';
import { browserImages } from './image-artifacts.js';

const tickets = new Map<string, { request: BrowserCommand; carrier: BrowserCarrier; call: string; bud: string; target?: string }>();
export function beginAgentCapture(request: BrowserCommand, carrier: BrowserCarrier, call: string, bud: string, target?: string) {
  for (const [key, value] of tickets) if (value.request.expires_at_ms < Date.now()) tickets.delete(key);
  if (tickets.size >= 32) throw Error('browser_capture_capacity');
  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, { request, carrier, call, bud, target });
  return { command: { action:'capture', target_id:target, endpoint:new URL('/api/browser/captures', config.betterAuthUrl).href, ticket }, dispose:() => tickets.delete(ticket) };
}
export async function registerAgentCaptures(server: FastifyInstance, repository: Pick<BrowserRepository, "evidenceAllowed"> = new BrowserRepository(), images = browserImages) {
  server.post('/api/browser/captures', { bodyLimit:1_420_000 }, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    const ticket = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.request.expires_at_ms < Date.now() || !entry.carrier.current() || !await repository.evidenceAllowed(entry.request)) return reply.code(403).send({error:'browser_capture_revoked'});
    const parsed = z.object({ target_id:z.string().max(128), document_id:z.string().max(128), image:z.string().max(1_400_000), image_format:z.literal('png').optional() }).passthrough().safeParse(request.body);
    if (!parsed.success || (entry.target && parsed.data.target_id !== entry.target)) return reply.code(400).send({error:'browser_invalid_capture'});
    const frame = parsed.data;
    const bytes = Buffer.from(frame.image,'base64');
    const png = frame.image_format === 'png';
    if (bytes.toString('base64') !== frame.image || (png ? !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] !== 255 || bytes[1] !== 216)) return reply.code(400).send({error:'browser_invalid_capture'});
    if (!entry.carrier.current() || !await repository.evidenceAllowed(entry.request)) return reply.code(403).send({error:'browser_capture_revoked'});
    const artifact = await images.put({ owner:entry.request.owner_user_id, thread:entry.request.thread_id, bud:entry.bud, call:entry.call,
      session:entry.request.session_id, generation:entry.request.generation, epoch:entry.request.control_epoch,
      target:frame.target_id, document:frame.document_id, image:frame.image, mime_type:png?'image/png':'image/jpeg' });
    return { image_artifact:{ ...artifact, path:`/api/threads/${entry.request.thread_id}/browser-images/${artifact.id}` }, target_id:frame.target_id, document_id:frame.document_id };
  });
  server.get('/api/threads/:thread_id/browser-images/:image_id', async (request, reply) => {
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
    const viewer = await requireViewer(request, reply);
    if (!viewer) return;
    const params = z.object({ thread_id:z.string().uuid(), image_id:z.string().max(128) }).parse(request.params);
    if (!await getAuthorizedThread(viewer,params.thread_id)) return reply.code(404).send({error:'not_found'});
    const image = await images.get(params.image_id,viewer.userId,params.thread_id);
    if (!image) return reply.code(404).send({error:'image_unavailable'});
    return reply.type(image.mime_type).send(Buffer.from(image.image,'base64'));
  });
}
