import { buildAbsoluteApiUrl } from '@/lib/transport'

type Event = 'ready' | 'changed' | 'lost' | 'revoked'
/** Owned by one authenticated visit, shared by its inventory/viewer/controls. */
export class BrowserStateFeed {
  private listeners = new Set<(event: Event) => void>()
  private socket?: WebSocket
  private retry?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof setTimeout>
  private connectQueued = false
  private failures = 0
  private revoked = false
  ready = false
  private path: string
  constructor(path: string) { this.path = path }
  subscribe(listener: (event: Event) => void) {
    this.listeners.add(listener)
    if (this.revoked) queueMicrotask(() => { if (this.listeners.has(listener)) listener('revoked') })
    else if (this.ready) queueMicrotask(() => { if (this.listeners.has(listener)) listener('ready') })
    else if (!this.socket && !this.retry && !this.connectQueued) {
      // React's synchronous setup/cleanup/setup probe must not open a socket
      // that cleanup immediately aborts during its handshake.
      this.connectQueued = true
      queueMicrotask(() => {
        this.connectQueued = false
        if (!this.socket && !this.retry) this.connect()
      })
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearTimeout(this.retry); clearTimeout(this.watchdog)
        this.retry = undefined
        const socket = this.socket; this.socket = undefined; this.ready = false
        socket?.close()
      }
    }
  }
  private emit(event: Event) { for (const listener of this.listeners) listener(event) }
  private connect() {
    if (!this.listeners.size || this.revoked) return
    const url = new URL(buildAbsoluteApiUrl(this.path))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    const live = () => this.socket === socket
    const deadline = () => {
      clearTimeout(this.watchdog)
      this.watchdog = setTimeout(() => { if (live()) { lost(); socket.close() } }, 45_000)
    }
    const lost = (terminal = false) => {
      if (!live()) return
      this.socket = undefined; this.ready = false
      clearTimeout(this.watchdog)
      this.revoked = terminal
      this.emit(terminal ? 'revoked' : 'lost')
      if (!terminal && this.listeners.size) this.retry = setTimeout(() => {
        this.retry = undefined; this.connect()
      }, Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)))
    }
    deadline()
    socket.onmessage = message => {
      if (!live() || typeof message.data !== 'string' || message.data.length > 256) return
      try {
        const value = JSON.parse(message.data)
        if (!['ready', 'changed', 'heartbeat'].includes(value.type)) return
        deadline()
        if (value.type === 'ready') { this.ready = true; this.failures = 0; this.emit('ready') }
        else if (value.type === 'changed' && this.ready) this.emit('changed')
      } catch { lost(); socket.close() }
    }
    socket.onerror = () => { lost(); socket.close() }
    socket.onclose = event => lost(event.code === 4401 || event.code === 4404)
  }
}

/** Serial, dirty-bit reconciliation. Only failed reads have a retry timer. */
export function observeBrowserState(feed: BrowserStateFeed, read: (signal: AbortSignal) => Promise<void | false>,
  options: {hidden?: () => boolean; lost?: () => void; revoked?: () => void} = {}) {
  let disposed = false, dirty = false, running = false, failures = 0
  let abort: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden' && !options.hidden?.()
  const run = async () => {
    if (disposed || running || !dirty || hidden()) return
    clearTimeout(timer)
    running = true; dirty = false; abort = new AbortController()
    try {
      if (await read(abort.signal) === false) { stop(); return }
      failures = 0
    } catch {
      if (!disposed && !abort.signal.aborted) {
        dirty = true
        timer = setTimeout(() => { timer = undefined; void run() }, Math.min(30_000, 2000 * 2 ** Math.min(failures++, 4)))
      }
    } finally {
      running = false
      if (!disposed && dirty && !timer) void run()
    }
  }
  const refresh = () => { dirty = true; if (!timer) void run() }
  const unsubscribe = feed.subscribe(event => {
    if (event === 'revoked') { options.revoked?.(); stop() }
    else if (event === 'lost') { abort?.abort(); options.lost?.(); refresh() }
    else { clearTimeout(timer); timer = undefined; refresh() }
  })
  const resume = () => { if (document.visibilityState !== 'hidden') refresh() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
  function stop() {
    disposed = true; abort?.abort(); clearTimeout(timer); unsubscribe()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume)
  }
  return {refresh, stop}
}
