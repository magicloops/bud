import test from 'node:test'
import assert from 'node:assert/strict'
import {act, createElement, StrictMode, useEffect} from 'react'
import {create, type ReactTestRenderer} from 'react-test-renderer'
import {register} from 'node:module'
import {StateSocket} from './state-feed.fixture'
import type {ApiAgentState} from '@/lib/api-types'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url,context,next) {
 if(url.endsWith('/features/browser/media.ts'))return {format:'module',source:'export class BrowserCanvas {constructor(...args){return new globalThis.__stateCanvas(...args)}}',shortCircuit:true};
 const r=await next(url,context);return r.format==='module'&&r.source?{...r,source:String(r.source).replaceAll('import.meta.env','({})')}:r;
}`)}`,import.meta.url)
const {BrowserStateFeed,observeBrowserState}=await import('./state-feed')
const {useBrowserPane}=await import('./pane')
const {BrowserViewer}=await import('./viewer')
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})

for(const privateControl of [false,true]) test(`mounted shared viewer: 60 seconds idle, private=${privateControl}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']})
  const originalSocket=globalThis.WebSocket, originalFetch=globalThis.fetch, originalDocument=globalThis.document
  const document=Object.assign(new EventTarget(),{visibilityState:'visible'})
  Object.assign(globalThis,{WebSocket:StateSocket,document})
  StateSocket.all=[]
  let captures=0, owns=false
  const sessionId='browser_01AAAAAAAAAAAAAAAAAAAAAAAA'
  const requests:{url:string;operation?:string}[]=[]
  const snapshot=()=>({session_id:sessionId,thread_id:'thread',bud_id:'bud',generation:'g',revision:owns?2:1,
    state:'ready',control_state:owns?'human_private':'agent',can_view:!owns,owns_control:owns})
  globalThis.fetch=async(url,init)=>{
    const operation=init?.body?JSON.parse(String(init.body)).operation:undefined
    requests.push({url:String(url),operation})
    if(operation==='acquire') owns=true
    if(operation==='release') owns=false
    if(String(url).endsWith('/browser-sessions'))return Response.json({sessions:[snapshot()]})
    if(String(url).endsWith('/browser'))return Response.json({browser:null})
    return Response.json(snapshot())
  }
  Object.assign(globalThis,{__stateCanvas:class {
    constructor(){captures++} close(){}
  }})
  const state={pending_tool:null} as ApiAgentState, reveal=()=>{}
  function Harness(){
    const pane=useBrowserPane('thread',[],state,reveal)
    return pane.sessionId?createElement(BrowserViewer,{sessionId:pane.sessionId,stateFeed:pane.stateFeed}):null
  }
  let view!:ReactTestRenderer
  try{
    await act(async()=>{view=create(createElement(Harness),{createNodeMock:()=>({value:''})})})
    assert.equal(StateSocket.all.length,1,'inventory, metadata and lifecycle share one socket')
    if(privateControl) await act(async()=>view.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.onClick())
    const before=requests.length, frames=captures
    document.visibilityState='hidden'
    await act(async()=>document.dispatchEvent(new Event('visibilitychange')))
    for(let n=0;n<12;n++)await act(async()=>{StateSocket.all[0].emit('heartbeat');t.mock.timers.tick(5000)})
    const added=requests.slice(before)
    assert.equal(added.length,privateControl?12:0)
    assert.ok(added.every(r=>r.operation==='renew'))
    assert.equal(captures,frames,'idle timers do not attach or recapture')
    document.visibilityState='visible'
    await act(async()=>document.dispatchEvent(new Event('visibilitychange')))
    assert.ok(requests.length>before+added.length,'resume reconciles once')
    await act(async()=>StateSocket.all[0].onclose?.({code:4404}))
    assert.equal(view.toJSON(),null,'live revocation clears the protected viewer')
  }finally{
    if(view)await act(async()=>view.unmount())
    Object.assign(globalThis,{WebSocket:originalSocket,fetch:originalFetch,document:originalDocument})
    Reflect.deleteProperty(globalThis,'__stateCanvas')
  }
})

test('read race coalesces bursts; hidden changes defer; lost channel fences and aborts stale reads',async()=>{
  const original=globalThis.WebSocket, originalDocument=globalThis.document
  const document=Object.assign(new EventTarget(),{visibilityState:'visible'})
  Object.assign(globalThis,{WebSocket:StateSocket,document})
  StateSocket.all=[];StateSocket.autoReady=false
  const pending:{signal:AbortSignal;resolve:()=>void}[]=[]
  const feed=new BrowserStateFeed('/api/threads/thread/browser-state')
  let lost=0
  const observer=observeBrowserState(feed,signal=>new Promise<void>(resolve=>pending.push({signal,resolve})),{lost:()=>lost++})
  try{
    assert.equal(pending.length,0,'subscription ready precedes initial read')
    await Promise.resolve()
    const socket=StateSocket.all[0];socket.emit('ready');assert.equal(pending.length,1)
    for(let n=0;n<20;n++)socket.emit('changed')
    assert.equal(pending.length,1)
    pending[0].resolve();await Promise.resolve();assert.equal(pending.length,2)
    pending[1].resolve();await Promise.resolve()
    document.visibilityState='hidden';socket.emit('changed');assert.equal(pending.length,2)
    document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));assert.equal(pending.length,3)
    socket.onerror?.();assert.equal(lost,1);assert.equal(pending[2].signal.aborted,true);assert.equal(feed.ready,false)
  }finally{observer.stop();StateSocket.autoReady=true;Object.assign(globalThis,{WebSocket:original,document:originalDocument})}
})

test('stalled channel reconnects with a fresh read and last unsubscribe cancels reconnect',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const original=globalThis.WebSocket
  Object.assign(globalThis,{WebSocket:StateSocket})
  StateSocket.all=[];StateSocket.autoReady=false
  const feed=new BrowserStateFeed('/api/threads/thread/browser-state')
  let reads=0, losses=0
  const observer=observeBrowserState(feed,async()=>{reads++},{lost:()=>losses++})
  try{
    await Promise.resolve()
    StateSocket.all[0].emit('ready');await Promise.resolve()
    assert.equal(reads,1)
    t.mock.timers.tick(45_000);await Promise.resolve()
    assert.equal(losses,1);assert.equal(feed.ready,false)
    assert.equal(StateSocket.all[0].closed,true)
    t.mock.timers.tick(1000)
    assert.equal(StateSocket.all.length,2)
    const beforeReady=reads
    StateSocket.all[1].emit('ready');await Promise.resolve()
    assert.equal(reads,beforeReady+1,'reconnect reconciles regardless of missed hints')
    observer.stop()
    t.mock.timers.tick(120_000)
    assert.equal(StateSocket.all.length,2)
    assert.equal(StateSocket.all[1].closed,true)
  }finally{observer.stop();StateSocket.autoReady=true;Object.assign(globalThis,{WebSocket:original})}
})


test('Strict Mode setup opens only the surviving socket; early disposal opens none', async () => {
  const original = globalThis.WebSocket
  Object.assign(globalThis, {WebSocket: StateSocket})
  StateSocket.all = []; StateSocket.autoReady = false
  const feed = new BrowserStateFeed('/api/threads/thread/browser-state')
  let setups = 0, cleanups = 0
  function Harness() {
    useEffect(() => {
      setups++
      const observer = observeBrowserState(feed, async () => {})
      return () => { cleanups++; observer.stop() }
    }, [])
    return null
  }
  let view: ReactTestRenderer | undefined
  try {
    await act(async () => { view = create(createElement(StrictMode, null, createElement(Harness))) })
    assert.equal(setups, 2, 'exercise development effect replay')
    assert.equal(cleanups, 1)
    assert.equal(StateSocket.all.length, 1, 'no throwaway handshake from first setup')
    assert.equal(StateSocket.all[0].closed, false)
    await act(async () => view!.unmount())
    assert.equal(StateSocket.all[0].closed, true, 'real disposal still closes immediately')
    const stop = feed.subscribe(() => {})
    stop()
    await Promise.resolve()
    assert.equal(StateSocket.all.length, 1, 'disposal before startup creates no socket')
  } finally {
    StateSocket.autoReady = true
    Object.assign(globalThis, {WebSocket: original})
  }
})
