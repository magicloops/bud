import { randomUUID } from 'node:crypto';
import { RequestMetrics } from './request-metrics.js';
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
  const histogram = new RequestMetrics();
  const instance = randomUUID();
  let intervalStart = new Date().toISOString();
  const flush = () => {
    const result = histogram.drain();
    const intervalEnd = new Date().toISOString();
    if (result.routes.length || result.dropped_observations) server.log.info({
      component: 'request_metrics', instance_id: instance,
      interval_start: intervalStart, interval_end: intervalEnd, ...result,
    }, 'HTTP latency histogram');
    intervalStart = intervalEnd;
  };
  const timer = setInterval(flush, 60_000);
  timer.unref();
  server.addHook('onClose', async () => { clearInterval(timer); flush(); });
  const metrics = new WeakMap<object, { started: number; handler_ms?: number; response_bytes?: number; rows?: number; headers_ms?: number; first_event_ms?: number }>();
  server.addHook('onRequest', async (request, reply) => {
    const metric = { started: performance.now() } as NonNullable<ReturnType<typeof metrics.get>>;
    metrics.set(request, metric);
    // SSE uses the raw response and bypasses Fastify's onSend hook. Observe only
    // timing/frame boundaries; never retain or log stream contents.
    const writeHead = reply.raw.writeHead;
    reply.raw.writeHead = function (this: typeof reply.raw, ...args: unknown[]) {
      const result = Reflect.apply(writeHead, this, args);
      metric.headers_ms ??= performance.now() - metric.started;
      return result;
    } as typeof writeHead;
    const write = reply.raw.write;
    let boundary = '';
    reply.raw.write = function (this: typeof reply.raw, chunk: unknown, ...args: unknown[]) {
      const result = Reflect.apply(write, this, [chunk, ...args]);
      const isSse = String(this.getHeader('content-type') ?? '').startsWith('text/event-stream');
      if (isSse && metric.first_event_ms === undefined && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const frame = boundary + text;
        if (frame.includes('\n\n') || frame.includes('\r\n\r\n')) {
          metric.first_event_ms = performance.now() - metric.started;
          request.log.info({ route: request.routeOptions.url ?? '<unmatched>',
            headers_ms: metric.headers_ms, first_event_ms: metric.first_event_ms }, 'SSE first frame');
        }
        boundary = frame.slice(-3).replace(/[^\r\n]/g, 'x');
      }
      return result;
    } as typeof write;
  });
  // These measurements are synchronous. Yielding here can leave reply.send()
  // pending after an existing async route handler has already returned.
  server.addHook('preSerialization', (request, _reply, payload, done) => {
    const metric = metrics.get(request);
    if (metric && payload && typeof payload === 'object') {
      const body = payload as Record<string, unknown>;
      const rows = Array.isArray(payload) ? payload : body.messages ?? body.threads;
      if (Array.isArray(rows)) metric.rows = rows.length;
    }
    done(null, payload);
  });
  server.addHook('onSend', (request, reply, payload, done) => {
    const metric = metrics.get(request);
    if (metric && !reply.raw.headersSent) {
      metric.handler_ms = performance.now() - metric.started;
      reply.header('Server-Timing', `total;dur=${metric.handler_ms.toFixed(2)}`);
      if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        metric.response_bytes = Buffer.byteLength(payload);
      }
    }
    done(null, payload);
  });
  server.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? '<unmatched>';
    const stream = !!request.headers.upgrade || String(reply.getHeader('content-type') ?? '').startsWith('text/event-stream');
    const duration_ms = Math.round(reply.elapsedTime);
    const { started: _started, ...measurement } = metrics.get(request) ?? { started: 0 };
    if (!stream) histogram.observe(request.method, route, reply.statusCode, reply.elapsedTime, measurement.response_bytes);
    request.log[accessLogLevel(request.method, route, reply.statusCode, duration_ms, stream)]({
      method: request.method, route, status_code: reply.statusCode, duration_ms,
      ...measurement,
    }, 'Request completed');
  });
}
