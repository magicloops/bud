import type { WebSocket } from 'ws';
import type { BrowserStateEvents, BrowserStateHint } from './state-events.js';

/** Authorization precedes subscription; hints never carry page data or authority. */
export async function attachBrowserState(socket: WebSocket, events: BrowserStateEvents,
  scope: BrowserStateHint, authorize: () => Promise<boolean>) {
  let stopped = false;
  let dirty = false;
  let checking = false;
  let revision = 0;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let security: ReturnType<typeof setInterval> | undefined;
  let pongAt = Date.now();
  const stop = () => { stopped = true; unsubscribe(); clearInterval(heartbeat); clearInterval(security); };
  socket.on('close', stop);
  socket.on('error', stop);
  socket.on('pong', () => { pongAt = Date.now(); });
  // This is a server-only feed. Bound unsolicited messages without parsing them.
  socket.on('message', () => socket.close(1008));
  const send = (type: string) => {
    if (stopped || socket.readyState !== 1) return;
    if (socket.bufferedAmount > 4096) { socket.terminate(); return; }
    socket.send(JSON.stringify({ type, revision }));
  };
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      do {
        const changed = dirty;
        dirty = false;
        if (!await authorize()) { socket.close(4404); stop(); return; }
        if (changed) { revision++; send('changed'); }
      } while (dirty && !stopped);
    } catch { socket.terminate(); stop(); }
    finally { checking = false; }
  };
  try {
    await events.ready();
    if (stopped) return;
    if (!await authorize()) { socket.close(4404); stop(); return; }
    if (stopped) return;
    unsubscribe = events.subscribe(hint => {
      if (hint.bud_id !== scope.bud_id ||
          (scope.thread_id && hint.thread_id && hint.thread_id !== scope.thread_id)) return;
      dirty = true;
      void check();
    }, () => { socket.terminate(); stop(); });
    send('ready');
    heartbeat = setInterval(() => {
      if (Date.now() - pongAt > 45_000) { socket.terminate(); stop(); return; }
      socket.ping();
      send('heartbeat');
    }, 15_000);
    // Authentication expiry is independent of transport liveness/state refresh.
    security = setInterval(() => void check(), 30_000);
  } catch { socket.terminate(); stop(); }
}
