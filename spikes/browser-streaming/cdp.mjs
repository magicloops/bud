// Disposable local capture probe only; this is not a browser-facing CDP API.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(new URL('../../service/package.json', import.meta.url));
export const WebSocket = require('ws');

export class Cdp extends EventEmitter {
  #next = 0;
  #pending = new Map();
  #closed = false;
  constructor(socket) {
    super();
    this.socket = socket;
    socket.on('message', (bytes) => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id);
          if (!pending) return;
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(`cdp_rejected:${pending.method}:${message.error.code}`));
          else pending.resolve(message.result);
        } else if (typeof message.method === 'string') {
          this.emit('event', message);
        }
      } catch {
        this.close('cdp_invalid_message');
      }
    });
    socket.on('error', () => this.close('cdp_transport_error'));
    socket.on('close', () => this.close('cdp_closed'));
  }
  static async connect(endpoint, maxPayload = 2 * 1024 * 1024) {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/devtools/browser/')) {
      throw new Error('non_owned_endpoint');
    }
    const socket = new WebSocket(endpoint, { maxPayload, perMessageDeflate: false, handshakeTimeout: 5000 });
    const cdp = new Cdp(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', () => reject(new Error('cdp_connect_failed')));
      socket.once('close', () => reject(new Error('cdp_connect_closed')));
    });
    return cdp;
  }
  call(method, params = {}, sessionId, timeoutMs = 5000) {
    if (this.#closed) return Promise.reject(new Error('cdp_closed'));
    if (this.#pending.size >= 32 || this.socket.bufferedAmount > 64 * 1024) {
      this.close('cdp_capacity');
      return Promise.reject(new Error('cdp_capacity'));
    }
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(`cdp_timeout:${method}`), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (error) => {
        if (error) this.close('cdp_send_failed');
      });
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    await this.call('Page.enable', {}, sessionId);
    return sessionId;
  }
  close(reason = 'cdp_disposed') {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
    this.socket.terminate();
    this.emit('ended', reason);
  }
}
