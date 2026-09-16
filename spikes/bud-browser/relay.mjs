import { createAgentBridge } from './agent-bridge.mjs';
// Disposable phase-0 relay. Run from service/ with its installed dependencies:
// pnpm exec node --import tsx ../spikes/bud-browser/relay.mjs
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../service/package.json', import.meta.url));
const Fastify = require('fastify');
const websocket = require('@fastify/websocket');
const { z } = require('zod');
const hash = value => createHash('sha256').update(value).digest('hex');
const text = z.string().max(8192);
const target = z.string().min(1).max(128);
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('targets') }).strict(),
  z.object({ action: z.literal('observe'), target }).strict(),
  z.object({ action: z.literal('navigate'), target, url: z.string().url().max(2048) }).strict(),
  z.object({ action: z.literal('focus'), reference: target }).strict(),
  z.object({ action: z.literal('insert_text'), text }).strict(),
  z.object({ action: z.literal('click'), reference: target }).strict(),
  z.object({ action: z.literal('takeover') }).strict(),
  z.object({ action: z.literal('heartbeat') }).strict(),
  z.object({ action: z.literal('return'), target }).strict(),
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('capture'), target }).strict(),
]);
const command = z.object({ epoch: z.number().int().positive(), command: action }).strict();

/** authorize must re-resolve authenticated thread AND Bud ownership in SQL.
 * Tests supply their own authority; the executable below uses service auth. */
export async function buildRelay({ authorize, origin, agentIntegration }) {
  const app = Fastify({ logger: false, bodyLimit: 16384 });
  const sessions = new Map();
  const tickets = new Map();
  const lifetime = 15 * 60 * 1000;
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Host connections use one-time bearer tickets. All browser writes and
    // upgrades require exact Origin; a cookie alone is not CSRF protection.
    if (!request.url.startsWith('/ws/browser-spike/') &&
        (request.method !== 'GET' || request.headers.upgrade) &&
        request.headers.origin !== origin) {
      return reply.code(403).send({ error: 'origin_denied' });
    }
  });

  const issue = (session, channel) => {
    const token = randomBytes(32).toString('base64url');
    tickets.set(hash(token), { session, channel, expires: Date.now() + 60000 });
    return token;
  };
  const end = session => {
    if (session.ended) return;
    session.ended = true;
    if (sessions.get(session.thread_id) === session) sessions.delete(session.thread_id);
    session.control?.close(); session.media?.close();
    session.pending?.reject(new Error('browser_disconnected'));
    session.capture?.reject(new Error('browser_disconnected'));
    for (const viewer of session.viewers) viewer.close();
    for (const [key, ticket] of tickets) if (ticket.session === session) tickets.delete(key);
  };
  const owned = async (request, reply) => {
    const owner = await authorize(request, reply, request.params.thread_id);
    if (!owner) return null;
    const session = sessions.get(request.params.thread_id);
    if (!session || session.owner !== owner) { reply.code(404).send({ error: 'not_found' }); return null; }
    return session;
  };
  const send = (session, viewer, epoch, operation) => {
    const media = operation.action === 'capture';
    const slot = media ? 'capture' : 'pending';
    const socket = media ? session.media : session.control;
    if (!session.ready || socket?.readyState !== 1) return Promise.reject(new Error('browser_offline'));
    if (session[slot] || socket.bufferedAmount > 2 * 1024 * 1024) return Promise.reject(new Error('browser_busy'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Unknown mutations are never retried. Destroy this disposable session
        // rather than admitting further commands against ambiguous results.
        end(session);
      }, 12000);
      session[slot] = { id, resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } };
      socket.send(JSON.stringify({ id, viewer, epoch, ...operation }));
    });
  };

  const agentBackend = agentIntegration ? createAgentBridge({ sessions, send, end,
    authorize: agentIntegration.authorize, persistHandoff: agentIntegration.persistHandoff }) : null;
  app.decorate('browserAgentBackend', agentBackend);

  app.post('/api/browser-spike/threads/:thread_id', async (request, reply) => {
    const owner = await authorize(request, reply, request.params.thread_id);
    if (!owner) return;
    if (sessions.has(request.params.thread_id)) return reply.code(409).send({ error: 'session_exists' });
    if (sessions.size >= 4) return reply.code(429).send({ error: 'spike_session_limit' });
    const session = { owner, thread_id: request.params.thread_id, epoch: 1, ready: false, viewers: new Set(), expires: Date.now() + lifetime };
    sessions.set(session.thread_id, session);
    return { host_ticket: issue(session, 'control'), media_ticket: issue(session, 'media'), expires_in: 60 };
  });
  app.delete('/api/browser-spike/threads/:thread_id', async (request, reply) => {
    const session = await owned(request, reply);
    if (session) { end(session); return { closed: true }; }
  });

  for (const [path, channel] of [['host', 'control'], ['media', 'media']]) {
    app.get(`/ws/browser-spike/${path}`, {
      websocket: true,
      preValidation: async (request, reply) => {
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        const key = hash(token);
        const ticket = tickets.get(key);
        if (!ticket || ticket.channel !== channel || ticket.expires <= Date.now()) {
          return reply.code(401).send({ error: 'invalid_ticket' });
        }
        tickets.delete(key);
        request.browserTicket = ticket;
      },
    }, (socket, request) => {
      const session = request.browserTicket.session;
      session[channel] = socket;
      socket.on('error', () => end(session));
      socket.on('close', () => { if (sessions.has(session.thread_id)) end(session); });
      socket.on('message', (bytes, binary) => {
        const slot = channel === 'media' ? 'capture' : 'pending';
        const pending = session[slot];
        if (binary) {
          if (channel !== 'media' || !pending || bytes.length > 1024 * 1024) return end(session);
          session[slot] = undefined;
          pending.resolve(bytes);
          return;
        }
        let value;
        try { value = JSON.parse(bytes.toString()); } catch { return end(session); }
        if (value.ready === true && channel === 'control' && !session.ready) { session.ready = true; return; }
        if (!pending || value.id !== pending.id) return end(session);
        session[slot] = undefined;
        if (Number.isSafeInteger(value.epoch)) session.epoch = value.epoch;
        pending.resolve(value);
      });
    });
  }

  // A manual agent-side contract probe, not yet registered with AgentService.
  app.post('/api/browser-spike/threads/:thread_id/agent', async (request, reply) => {
    const session = await owned(request, reply);
    if (!session) return;
    const parsed = command.safeParse(request.body);
    if (!parsed.success || ['takeover', 'heartbeat', 'return', 'pause', 'capture'].includes(parsed.data.command.action)) {
      return reply.code(400).send({ error: 'invalid_command' });
    }
    try { return await send(session, null, parsed.data.epoch, parsed.data.command); }
    catch { return reply.code(409).send({ error: 'browser_unavailable' }); }
  });
  app.get('/api/browser-spike/threads/:thread_id/viewer', {
    websocket: true,
    preValidation: async (request, reply) => { request.browserSession = await owned(request, reply); },
  }, (socket, request) => {
    const session = request.browserSession;
    if (!session || session.viewers.size >= 3) { socket.close(); return; }
    const viewer = randomUUID();
    session.viewers.add(socket);
    socket.send(JSON.stringify({ ready: session.ready, epoch: session.epoch }));
    let busy = false;
    socket.on('error', () => socket.close());
    socket.on('close', () => { session.viewers.delete(socket); /* host lease expires; never resume */ });
    socket.on('message', async bytes => {
      if (bytes.length > 16384) { socket.close(1009); return; }
      if (busy) { socket.send(JSON.stringify({ error: 'viewer_busy' })); return; }
      busy = true;
      try {
        // Recheck deletion/unclaim/ownership on every observation/input.
        const owner = await authorize(request, { code: () => ({ send: () => {} }) }, session.thread_id);
        if (owner !== session.owner) { socket.close(1008); return; }
        const parsed = command.safeParse(JSON.parse(bytes.toString()));
        if (!parsed.success) { socket.send(JSON.stringify({ error: 'invalid_command' })); return; }
        const result = await send(session, viewer, parsed.data.epoch, parsed.data.command);
        if (parsed.data.command.action === 'return' && !result.error && result.result) {
          await agentBackend?.returned(session, result.result, agentIntegration.persistReturn);
        }
        if (socket.readyState === 1 && socket.bufferedAmount <= 2 * 1024 * 1024) {
          socket.send(Buffer.isBuffer(result) ? result : JSON.stringify(result));
        } else socket.close(1013);
      } catch { if (socket.readyState === 1) socket.send(JSON.stringify({ error: 'browser_unavailable' })); }
      finally { busy = false; }
    });
  });
  app.get('/api/browser-spike/threads/:thread_id/view', async (request, reply) => {
    if (!await owned(request, reply)) return;
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; base-uri 'none'");
    return reply.type('text/html').send(await readFile(new URL('./viewer.html', import.meta.url), 'utf8'));
  });
  for (const [file, type] of [['viewer.js', 'application/javascript'], ['viewer.css', 'text/css']]) {
    app.get(`/api/browser-spike/${file}`, async (_request, reply) => reply.type(type).send(await readFile(new URL(`./${file}`, import.meta.url), 'utf8')));
  }
  const timer = setInterval(() => {
    for (const session of sessions.values()) if (session.expires <= Date.now()) end(session);
    for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key);
  }, 1000);
  timer.unref();
  app.addHook('preClose', async () => { clearInterval(timer); for (const session of sessions.values()) end(session); });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { requireViewer, getAuthorizedThread, getAuthorizedBud } = await import('../../service/src/auth/session.ts');
  const origin = process.env.BUD_BROWSER_SPIKE_ORIGIN ?? 'http://localhost:3444';
  const app = await buildRelay({ origin, authorize: async (request, reply, id) => {
    const viewer = await requireViewer(request, reply);
    if (!viewer) return null;
    const thread = await getAuthorizedThread(viewer, id);
    if (!thread || !thread.budId || !await getAuthorizedBud(viewer, thread.budId)) {
      reply.code(404).send({ error: 'not_found' }); return null;
    }
    return viewer.userId;
  } });
  await app.listen({ host: '127.0.0.1', port: Number(process.env.BUD_BROWSER_SPIKE_PORT ?? 3444) });
  console.log('Browser spike relay listening on loopback; sessions expire after 15 minutes.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close().then(() => process.exit()));
}
