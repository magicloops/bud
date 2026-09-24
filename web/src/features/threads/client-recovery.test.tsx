import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, act, StrictMode } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { useTerminalSession } = await import('./use-terminal-session')
const { useAgentStream } = await import('./use-agent-stream')
const { useBrowserPane } = await import('../browser/pane')
const { ApiError } = await import('@/lib/transport')
import type { ApiAgentState } from '@/lib/api-types'
const noop = () => {}
const authorized = (response?: Response | null) => response?.status === 401
const state = { pending_tool: null, stream_cursor: 'fresh' } as ApiAgentState

class Source extends EventTarget {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static all: Source[] = []
  readyState = 0
  onerror: (() => void) | null = null
  constructor(readonly url: string) { super(); Source.all.push(this) }
  close() { this.readyState = 2 }
  emit(type: string, data = {}) {
    if (type === 'open') this.readyState = 1
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
  fail() { if (this.readyState !== 2) this.readyState = 0; this.onerror?.(); this.emit('error') }
}

async function fixture(body: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup()
  try { await body(f) } finally { await f.dispose() }
}
function setup() {
  const originals = { fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    EventSource: globalThis.EventSource, requestAnimationFrame: globalThis.requestAnimationFrame,
    info: console.info, warn: console.warn, debug: console.debug, now: Date.now }
  let now = 0, id = 0
  const timers = new Map<number, { at: number; callback: () => void; interval: number }>()
  const logs: { level: string; fields: Record<string, unknown> }[] = []
  const requests: string[] = []
  let response: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => {
    if (url.endsWith('/ensure')) return Response.json({})
    if (url.includes('/snapshot')) return Response.json({ ring_next_offset: 42, history_text: 'retained output' })
    if (url.endsWith('/browser-sessions')) return Response.json({ sessions: [] })
    return Response.json({ session_id: 'session' })
  }
  const set = (callback: () => void, delay: number, interval = 0) => {
    timers.set(++id, { at: now + delay, callback, interval }); return id
  }
  Source.all = []
  Object.assign(globalThis, {
    EventSource: Source, requestAnimationFrame: () => 0,
    fetch: (url: string, init?: RequestInit) => { requests.push(String(url)); return Promise.resolve(response(String(url), init)) },
    setTimeout: (cb: () => void, ms = 0) => set(cb, ms),
    clearTimeout: (n: number) => timers.delete(n),
    setInterval: (cb: () => void, ms: number) => set(cb, ms, ms),
    clearInterval: (n: number) => timers.delete(n),
  })
  Date.now = () => now
  for (const level of ['info', 'warn', 'debug'] as const) console[level] = (_name: unknown, fields: Record<string, unknown>) => logs.push({ level, fields })
  let view: ReactTestRenderer | null = null
  let terminal!: ReturnType<typeof useTerminalSession>
  let pane!: ReturnType<typeof useBrowserPane>
  let reveals = 0
  const reveal = () => { reveals++ }
  const onError = (message: string | null) => errors.push(message)
  const errors: (string | null)[] = []
  function Terminal({ thread }: { thread: string | null }) {
    terminal = useTerminalSession({ budId: 'bud', threadId: thread, viewMode: 'chat', threadPanelOpen: true,
      onError, shouldAbortForUnauthorized: authorized, updateBudStatus: noop })
    return null
  }
  function Pane({ thread }: { thread: string }) {
    pane = useBrowserPane(thread, [], state, reveal)
    return null
  }
  let bootstrap: () => Promise<ApiAgentState> = async () => state
  function Agent({ thread }: { thread: string | null }) {
    useAgentStream({ threadId: thread, initialStreamCursor: 'old', refreshBootstrap: () => bootstrap(),
      onStatusChange: noop, onError, onStreamEvent: noop, onOutputActivity: noop,
      onToolCall: noop, onToolResultMessage: noop, onAssistantMessageStart: noop,
      onAssistantMessageDelta: noop, onAssistantMessageDone: noop, onAssistantMessageEvent: noop,
      onReasoningStart: noop, onReasoningDelta: noop, onReasoningDone: noop,
      onThreadTitle: noop, onFinalizeTurn: noop })
    return null
  }
  return {
    requests, logs, errors, timers,
    get terminal() { return terminal }, get pane() { return pane }, get reveals() { return reveals },
    setResponse(fn: typeof response) { response = fn }, setBootstrap(fn: typeof bootstrap) { bootstrap = fn },
    async mount(kind = 'terminal', thread: string | null = 'A', strict = false) {
      await act(async () => {
        const node = createElement(kind === 'agent' ? Agent : kind === 'pane' ? Pane : Terminal, { thread })
        view = create(strict ? createElement(StrictMode, null, node) : node)
      })
    },
    async switch(thread: string | null, kind = 'terminal') {
      await act(async () => view!.update(createElement(kind === 'agent' ? Agent : Terminal, { thread })))
    },
    async advance(ms: number) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        if (next[1].interval) next[1].at += next[1].interval
        else timers.delete(next[0])
        await act(async () => {
          // Keep healthy simulated transports alive, independently of the daemon.
          for (const s of Source.all) if (s.readyState === 1) s.emit('heartbeat')
          next[1].callback()
        })
      }
      now = end
    },
    async open() { await act(async () => Source.all.at(-1)!.emit('open')) },
    async dispose() {
      await act(async () => view?.unmount())
      Object.assign(globalThis, { fetch: originals.fetch, setTimeout: originals.setTimeout, clearTimeout: originals.clearTimeout,
        setInterval: originals.setInterval, clearInterval: originals.clearInterval, EventSource: originals.EventSource,
        requestAnimationFrame: originals.requestAnimationFrame })
      Date.now = originals.now
      console.info = originals.info; console.warn = originals.warn; console.debug = originals.debug
    },
  }
}
const offline = () => Response.json({ error: 'bud_offline' }, { status: 503 })
const count = (requests: string[], path: string) => requests.filter(url => url.includes(path)).length

test('60-second offline mount: six ensures, no snapshots or warnings; missed online event recovers', async () => fixture(async f => {
  let online = false
  f.setResponse(url => url.endsWith('/ensure') ? online ? Response.json({}) : offline()
    : url.includes('/snapshot') ? Response.json({ ring_next_offset: 42, history_text: 'restored' })
    : Response.json({ session_id: 's' }))
  await f.mount(); await f.open()
  await f.advance(60_000)
  assert.equal(count(f.requests, '/ensure'), 6) // t=0,2,6,14,30,60 (inclusive boundary)
  assert.equal(count(f.requests, '/snapshot'), 0)
  assert.equal(f.terminal.terminalConnection, 'offline')
  assert.equal(f.logs.filter(l => l.level === 'warn').length, 0)
  online = true
  await f.advance(30_000); await f.open()
  assert.equal(f.terminal.terminalConnection, 'connected')
  assert.equal(count(f.requests, '/snapshot'), 1)
}))

for (const outcome of ['success', 'offline'] as const) test(`Bud-online racing with pending ${outcome} coalesces without losing wake-up`, async () => fixture(async f => {
  await f.mount(); await f.open()
  const source = Source.all.at(-1)!
  const before = f.requests.length
  let resolve!: (r: Response) => void
  let ensures = 0
  f.setResponse(url => {
    if (url.endsWith('/ensure')) {
      ensures++
      return ensures === 1 ? new Promise(r => { resolve = r }) : Response.json({})
    }
    return Response.json({ ring_next_offset: 99, history_text: 'new' })
  })
  await act(async () => source.emit('terminal.bud_offline'))
  await f.advance(2000)
  assert.equal(ensures, 1)
  await act(async () => { source.emit('terminal.bud_online'); source.emit('terminal.bud_online') })
  assert.equal(ensures, 1)
  await act(async () => resolve(outcome === 'success' ? Response.json({}) : offline()))
  await f.advance(0); await f.open()
  assert.equal(ensures, outcome === 'success' ? 1 : 2)
  assert.equal(count(f.requests.slice(before), '/snapshot'), 1)
  assert.equal(Source.all.length, 2)
  assert.equal(f.terminal.terminalConnection, 'connected')
  await f.advance(30_000)
  assert.equal(ensures, outcome === 'success' ? 1 : 2)
}))

test('CONNECTING waits for open; online bypasses capped delay and keeps output', async () => fixture(async f => {
  await f.mount(); await f.open()
  const retained = f.terminal.terminalGridState.scrollback
  const source = Source.all.at(-1)!
  f.setResponse(url => url.endsWith('/ensure') ? offline() : Response.json({}))
  await act(async () => source.emit('terminal.bud_offline'))
  source.readyState = 0
  const before = f.requests.length
  await f.advance(8000)
  assert.equal(f.requests.length, before)
  await f.open(); await f.advance(2000)
  assert.equal(f.requests.length, before + 1)
  assert.deepEqual(f.terminal.terminalGridState.scrollback, retained)
  f.setResponse(url => Response.json(url.includes('/snapshot') ? { ring_next_offset: 100, history_text: 'new' } : {}))
  await act(async () => source.emit('terminal.bud_online'))
  await f.advance(0); await f.open()
  assert.equal(f.terminal.terminalConnection, 'connected')
}))

test('service 502 and simultaneous stream errors recover once without recreating session', async () => fixture(async f => {
  await f.mount(); await f.open()
  const source = Source.all.at(-1)!
  let unavailable = true
  f.setResponse(url => unavailable ? Response.json({}, { status: 502 }) : Response.json({}))
  await act(async () => { source.fail(); source.fail() })
  await f.advance(500)
  await f.open()
  assert.equal(f.terminal.terminalConnection, 'reconnecting')
  unavailable = false
  await f.advance(2000)
  assert.equal(f.terminal.terminalConnection, 'connected')
  assert.equal(count(f.requests, '/snapshot'), 1)
  assert.equal(f.requests.filter(u => u.endsWith('/terminal')).length, 1)
  assert.equal(Source.all.filter(s => s.readyState !== 2).length, 1)
}))

test('obsolete decoded snapshot cannot publish across A → B → A or logout', async () => fixture(async f => {
  const pending: { signal?: AbortSignal | null; resolve: (r: Response) => void }[] = []
  f.setResponse((url, init) => url.includes('/snapshot') ? new Promise(resolve => pending.push({ signal: init?.signal, resolve })) : Response.json({ session_id: url }))
  await f.mount()
  await f.switch('B'); await f.switch('A')
  assert.equal(pending.length, 3)
  assert.equal(pending[0].signal?.aborted, true)
  await act(async () => pending[0].resolve(Response.json({ ring_next_offset: 100, history_text: 'stale' })))
  assert.equal(Source.all.length, 0)
  await f.switch(null)
  await act(async () => pending[2].resolve(Response.json({ ring_next_offset: 100, history_text: 'late' })))
  assert.equal(f.terminal.currentSessionId, null)
  assert.equal(Source.all.length, 0)
}))

for (const status of [401, 403, 404, 410]) test(`terminal ${status} stops and clears protected view`, async () => fixture(async f => {
  await f.mount(); await f.open()
  f.setResponse(() => Response.json({}, { status }))
  await act(async () => Source.all.at(-1)!.emit('terminal.bud_offline'))
  await f.advance(2000)
  assert.equal(f.terminal.terminalConnection, 'disconnected')
  assert.equal(f.terminal.currentSessionId, null)
  assert.equal(f.terminal.terminalGridState.scrollback.length, 0)
  const before = f.requests.length
  await f.advance(60_000)
  assert.equal(f.requests.length, before)
}))

test('Strict Mode discards canceled first attachment and leaves one stream', async () => fixture(async f => {
  await f.mount('terminal', 'A', true); await f.open()
  assert.equal(Source.all.filter(s => s.readyState !== 2).length, 1)
  assert.equal(count(f.requests, '/snapshot'), 1)
}))

test('inventory backs off 10/20/30, reveals live handoff immediately, resets on success and stops at 404', async () => fixture(async f => {
  const session = 'browser_01AAAAAAAAAAAAAAAAAAAAAAAA'
  let status = 200
  f.setResponse(() => status === 200 ? Response.json({ sessions: [{ session_id: session, state: 'ready', handoff: null }] }) : Response.json({}, { status }))
  await f.mount('pane')
  status = 502
  await f.advance(5000)
  await act(async () => f.pane.notice({ viewer_path: `/browser/${session}`, handoff_id: 'new' }))
  assert.equal(f.reveals, 1)
  assert.equal(f.pane.sessionId, session)
  await f.advance(9999); assert.equal(f.requests.length, 2)
  await f.advance(1); assert.equal(f.requests.length, 3)
  await f.advance(20_000); assert.equal(f.requests.length, 4)
  status = 200
  await f.advance(30_000); assert.equal(f.requests.length, 5)
  await f.advance(5000); assert.equal(f.requests.length, 6)
  assert.equal(f.reveals, 1)
  status = 404
  await f.advance(5000)
  assert.equal(f.pane.sessionId, null)
  await f.advance(60_000); assert.equal(f.requests.length, 7)
  assert.equal(f.logs.filter(l => l.level === 'warn').length, 2) // one 502 class, one 404
}))

test('agent bootstrap uses stable retry trigger, deduplicates failures and fences obsolete errors', async () => fixture(async f => {
  let calls = 0
  f.setBootstrap(async () => {
    calls++
    if (calls <= 2) throw new ApiError('do not log raw content', 502, 'sensitive upstream body')
    return state
  })
  await f.mount('agent'); await f.open()
  const old = Source.all.at(-1)!
  await act(async () => old.fail())
  await f.advance(500); await f.advance(1000)
  assert.equal(calls, 3)
  await f.open()
  assert.equal(f.logs.filter(l => l.level === 'warn').length, 1)
  assert.equal(JSON.stringify(f.logs).includes('sensitive'), false)
  assert.equal(JSON.stringify(f.logs).includes('_retry'), false)
  const before = f.logs.length
  await act(async () => old.fail())
  assert.equal(f.logs.length, before)
  assert.equal(calls, 3)
  await f.switch('B', 'agent')
  assert.equal(Source.all.filter(s => s.readyState !== 2).length, 1)
}))


test('initial service failure backs off without creating streams, then attaches once', async () => fixture(async f => {
  let online = false
  f.setResponse(url => !online ? Response.json({}, { status: 502 })
    : Response.json(url.includes('/snapshot') ? { ring_next_offset: 1, history_text: 'loaded' } : { session_id: 's' }))
  await f.mount()
  await f.advance(6000)
  assert.equal(f.requests.length, 3)
  assert.equal(Source.all.length, 0)
  online = true
  await f.advance(8000); await f.open()
  assert.equal(Source.all.length, 1)
  assert.equal(f.terminal.terminalConnection, 'connected')
}))

test('changed failure class remains visible, while repeated identical errors are deduplicated', async () => fixture(async f => {
  let status = 502
  f.setResponse(() => Response.json({ error: status === 502 ? 'upstream_down' : 'database_unavailable' }, { status }))
  await f.mount(); await f.advance(2000)
  status = 503
  await f.advance(4000); await f.advance(8000)
  assert.deepEqual(f.logs.filter(l => l.level === 'warn').map(l => l.fields.code), ['upstream_down', 'database_unavailable'])
  assert.equal(f.logs.filter(l => l.fields.event === 'started').length, 1)
}))

test('agent definitive bootstrap loss stops retries and late bootstrap cannot attach into a new visit', async () => fixture(async f => {
  let resolve!: (s: ApiAgentState) => void
  f.setBootstrap(() => new Promise(r => { resolve = r }))
  await f.mount('agent'); await f.open()
  await act(async () => Source.all.at(-1)!.fail())
  await f.switch('B', 'agent')
  await act(async () => resolve(state))
  assert.equal(Source.all.length, 2)
  f.setBootstrap(async () => { throw new ApiError('missing', 404, {}) })
  await f.open()
  await act(async () => Source.all.at(-1)!.fail())
  await f.advance(60_000)
  assert.equal(Source.all.length, 2)
  assert.equal(Source.all.filter(s => s.readyState !== 2).length, 0)
}))
