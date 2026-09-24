import type { FastifyInstance } from 'fastify';

const quiet = new Set([
  '/healthz', '/readyz', '/api/threads/:thread_id/browser-sessions',
  '/api/browser/sessions/:session_id', '/api/buds/:bud_id/browser',
  '/api/threads/:threadId/agent/state',
]);
export function accessLogLevel(method: string, route: string, status: number, duration: number, stream: boolean) {
  if (status >= 500) return 'error';
  if (!stream && duration >= 1000) return 'warn';
  if (status >= 400) return 'warn';
  return stream || ((method === 'GET' || method === 'HEAD') && quiet.has(route)) ? 'debug' : 'info';
}
/** One completion record; route templates never include query strings or IDs. */
export function registerAccessLog(server: FastifyInstance) {
  server.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? '<unmatched>';
    const stream = !!request.headers.upgrade || String(reply.getHeader('content-type') ?? '').startsWith('text/event-stream');
    const duration_ms = Math.round(reply.elapsedTime);
    request.log[accessLogLevel(request.method, route, reply.statusCode, duration_ms, stream)]({
      method: request.method, route, status_code: reply.statusCode, duration_ms,
    }, 'Request completed');
  });
}
