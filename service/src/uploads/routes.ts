import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { requireViewer, type Viewer } from '../auth/session.js';
import { config } from '../config.js';
import { fileIntent, FileError, MAX_FILE_BYTES } from './contracts.js';
import { files, attachment, type FileRepository } from './repository.js';
import { fileObjects, originalBytes, type FileObjects } from './objects.js';

export async function registerUploadRoutes(server: FastifyInstance, dependencies: {
  repository?: FileRepository; objects?: () => FileObjects;
  viewer?: (request: FastifyRequest, reply: FastifyReply) => Promise<Viewer | null>;
} = {}): Promise<void> {
  const repository = dependencies.repository ?? files;
  const objects = dependencies.objects ?? fileObjects;
  // Validate storage before Fastify can listen/declare the deployment healthy.
  await objects().prepare();
  const viewers = new WeakMap<FastifyRequest, Viewer>();
  let uploading = 0;
  let cleanup: Promise<void> | undefined;
  const clean = () => cleanup ??= (async () => {
    await objects().prepare();
    for (const row of await repository.cleanupCandidates()) {
      await objects().remove(row.id);
      await repository.forget([row.id]);
    }
  })().catch(() => server.log.warn({ code: 'file_cleanup_failed' }, 'File cleanup failed'))
    .finally(() => { cleanup = undefined; });
  const timer = setInterval(() => void clean(), 60_000);
  timer.unref();
  server.addHook('onClose', async () => { clearInterval(timer); await cleanup; });
  await server.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
      const viewer = await (dependencies.viewer ?? requireViewer)(request, reply);
      if (!viewer) return;
      if (request.method !== 'GET' && request.method !== 'HEAD' &&
        (viewer.authType === 'cookie' || request.headers.origin !== undefined) &&
        (!request.headers.origin || !config.betterAuthTrustedOrigins.includes(request.headers.origin))) {
        return reply.code(403).send({ error: 'origin_denied' });
      }
      viewers.set(request, viewer);
    });
    routes.setErrorHandler((error, _request, reply) => {
      const status = error instanceof FileError ? error.status : error instanceof z.ZodError ? 400 : 503;
      return reply.code(status).send({ error: error instanceof FileError ? error.code : status === 400 ? 'invalid_file_request' : 'file_unavailable' });
    });
    const owner = (request: FastifyRequest) => viewers.get(request)!.userId;
    const id = (request: FastifyRequest) => (request.params as { file_id: string }).file_id;
    routes.post('/api/uploads', { bodyLimit: 4096 }, async (request, reply) => {
      await objects().prepare(); // Fail before reserving quota if the mount is unavailable.
      const row = await repository.reserve(owner(request), fileIntent.parse(request.body));
      return reply.code(201).send(attachment(row));
    });
    routes.put('/api/uploads/:file_id/content', { bodyLimit: MAX_FILE_BYTES }, async request => {
      if (!(request.body instanceof Readable)) throw new FileError('expected_file_bytes', 415);
      if (uploading >= 8) throw new FileError('upload_busy', 429);
      const row = await repository.begin(owner(request), id(request));
      uploading++;
      const source = request.body;
      const timeout = setTimeout(() => source.destroy(new Error('upload_timeout')), 120_000);
      try {
        const verified = await objects().receive(row.id, row.sizeBytes, source);
        const saved = await repository.finish(owner(request), row.id, verified.sha256);
        return attachment(saved);
      } catch (error) {
        await repository.fail(owner(request), row.id);
        await objects().remove(row.id).catch(() => {});
        throw error;
      } finally { clearTimeout(timeout); uploading--; }
    });
    routes.get('/api/uploads/:file_id', async request => attachment(await repository.owned(owner(request), id(request))));
    routes.get('/api/uploads/:file_id/content', async (request, reply) => {
      const file = await repository.owned(owner(request), id(request));
      const bytes = await originalBytes(objects(), file.id, file.sizeBytes, file.sha256!);
      await repository.owned(owner(request), file.id);
      return reply.type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`)
        .send(bytes);
    });
    routes.delete('/api/uploads/:file_id', async (request, reply) => {
      await repository.remove(owner(request), id(request));
      // Revocation is durable even if the upload disk is temporarily unavailable.
      await objects().remove(id(request)).catch(() => {});
      return reply.code(204).send();
    });
  });
}
