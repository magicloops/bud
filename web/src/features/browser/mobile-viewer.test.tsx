import {beforeEach, afterEach} from 'node:test'
import {StateSocket} from './state-feed.fixture'
const realSocket = globalThis.WebSocket
beforeEach(() => { StateSocket.all = []; globalThis.WebSocket = StateSocket as unknown as typeof WebSocket })
afterEach(() => { globalThis.WebSocket = realSocket })
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,act} from 'react';
import {create,type ReactTestRenderer} from 'react-test-renderer';
import {register} from 'node:module';
register(`data:text/javascript,${encodeURIComponent(`export async function load(url,context,next){
 if(url.endsWith('/features/browser/media.ts'))return {format:'module',source:'export class BrowserCanvas {constructor(...args){return new globalThis.__mobileCanvas(...args)}}',shortCircuit:true};
 const result=await next(url,context);if(result.format==='module'&&result.source)return {...result,source:String(result.source).replaceAll('import.meta.env','({})')};return result;
}`)}`,import.meta.url);
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

test('mobile suspension fences a late takeover and resumes passively with stable viewer identity',async()=>{
 const original=globalThis.fetch, intervals=globalThis.setInterval, clear=globalThis.clearInterval;
 const ops:string[]=[], identities:string[]=[];
 let ensures=0;
 let acquired!:(r:Response)=>void;
 class Canvas {frame=null;close(){} }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.setInterval=(()=>12345) as typeof setInterval;globalThis.clearInterval=(()=>{}) as typeof clearInterval;
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'agent',revision:1,can_view:true,can_resize_viewport:true,can_resize_agent_viewport:true};
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/ensure')) { ensures++; return Response.json(metadata); }
  assert.ok(!String(url).endsWith('/viewport'),'no fit before a displayed frame');
  if(String(url).endsWith('/control')){const body=JSON.parse(String(init?.body));ops.push(body.operation);identities.push(body.viewer_id);
   if(body.operation==='acquire')return new Promise(resolve=>{acquired=resolve});
   return Response.json({...metadata,control_state:'paused',can_view:false});}
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 let view!:ReactTestRenderer;
 const props={sessionId:'browser',mobile:true,hostViewerId:'stable-viewer',embedded:true};
 const canvas=Object.assign(new EventTarget(),{style:{},setPointerCapture(){}});
 try{
  await act(async()=>{view=create(createElement(BrowserViewer,{...props,active:false}),{createNodeMock:e=>e.type==='canvas'?canvas:e.type==='textarea'?{value:'',blur(){}}:null})});
  assert.equal(ensures,0,'hidden visit must not ensure or launch Chrome');
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:true})));
  assert.equal(ensures,1);
  await act(async()=>view.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.onClick());
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:false})));
  await act(async()=>acquired(Response.json({...metadata,control_state:'human_private',revision:2,can_view:false})));
  assert.deepEqual(ops,['acquire','release']);
  assert.equal(ensures,1,'suspension must not launch another recovery');
  assert.ok(view.root.findByType('textarea').props.disabled);
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:true})));
  assert.deepEqual(ops,['acquire','release'],'foreground must not reacquire or return');
  assert.deepEqual(identities,['stable-viewer','stable-viewer']);
 }finally{if(view)await act(async()=>view.unmount());globalThis.fetch=original;globalThis.setInterval=intervals;globalThis.clearInterval=clear;}
});

test('mobile fits the phone surface while agent-controlled, stops on suspension and preserves media on fit failure', async () => {
 const originalFetch=globalThis.fetch, originalObserver=globalThis.ResizeObserver;
 const clients: Canvas[]=[];
 const writes: {path:string;body:Record<string,unknown>}[]=[];
 let measure=()=>{}, width=390, height=740, rejectFit=false;
 class Canvas {
  frame={target_id:'page',document_id:'doc',frame_token:'frame',viewport_id:'old',width:1200,height:900,targets:[{target_id:'page',origin:'https://example.test'}]};
  closed=false;
  constructor(_canvas:unknown,_url:string,_viewer:string,readonly status:(state:string,targets:typeof this.frame.targets)=>void){clients.push(this)}
  show(){this.status('connected',this.frame.targets)}
  close(){this.closed=true}
 }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.ResizeObserver=class {constructor(callback:()=>void){measure=callback}observe(){}disconnect(){}} as unknown as typeof ResizeObserver;
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'agent',revision:1,can_view:true,can_resize_viewport:true,can_resize_agent_viewport:true};
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/ensure')) return Response.json(metadata);
  if(init?.method==='POST'){
   writes.push({path:String(url),body:JSON.parse(String(init.body))});
   assert.ok(String(url).endsWith('/viewport'),'fitting must not acquire control');
   return rejectFit ? Response.json({error:'browser_viewport_owner_conflict'},{status:409}) : Response.json({viewport_id:'phone'});
  }
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 const props={sessionId:'browser',mobile:true,hostViewerId:'phone-viewer',embedded:true};
 const canvas=Object.assign(new EventTarget(),{style:{},setPointerCapture(){}});
 let view!:ReactTestRenderer;
 const settle=async()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,180))});
 try{
  await act(async()=>{view=create(createElement(BrowserViewer,{...props,active:true}),{createNodeMock:e=>e.type==='canvas'?canvas:e.type==='textarea'?{value:'',blur(){}}:e.type==='div'?{getBoundingClientRect:()=>({width,height})}:null})});
  assert.equal(view.root.findByType('input').props.checked,true);
  assert.equal(view.root.findByType('input').props.disabled,false);
  assert.equal(writes.length,0);
  await act(async()=>clients.at(-1)!.show());await settle();
  assert.deepEqual(writes[0].body,{width:390,height:740,viewer_id:'phone-viewer',target_id:'page',document_id:'doc'});
  assert.equal(clients.length,1);
  width=740;height=390;await act(async()=>measure());await settle();
  assert.equal(writes[1].body.width,740);
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:false})));
  width=400;await act(async()=>measure());await settle();
  assert.equal(writes.length,2,'suspension must stop resizing');
  rejectFit=true;
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:true})));
  await act(async()=>clients.at(-1)!.show());await settle();
  const current=clients.at(-1)!;
  assert.equal(current.closed,false,'fit failure must preserve passive media');
  assert.equal(view.root.findByType('input').props.checked,false);
  await settle();assert.equal(writes.length,3,'uncertain fitting is not retried');
 }finally{if(view)await act(async()=>view.unmount());globalThis.fetch=originalFetch;globalThis.ResizeObserver=originalObserver;}
});

test('hosted authorization loss notifies native once and never retries ensure', async () => {
 const original=globalThis.fetch;
 let losses=0, ensures=0;
 globalThis.fetch=async(url)=>{
  if(String(url).endsWith('/ensure'))ensures++;
  return Response.json({error:'unauthorized'},{status:401});
 };
 const {BrowserViewer}=await import('./viewer');
 let view:ReactTestRenderer|undefined;
 try {
  await act(async()=>{view=create(createElement(BrowserViewer,{sessionId:'browser',mobile:true,active:true,
    hostViewerId:'viewer',onAuthorizationLost:()=>{losses++;}}));});
  assert.equal(losses,1);
  assert.equal(ensures,0);
  await act(async()=>StateSocket.change());
  assert.equal(losses,1);
 } finally {if(view)await act(async()=>view.unmount());globalThis.fetch=original;}
});
