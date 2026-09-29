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
  await act(async()=>acquired(Response.json({...metadata,override_id:'override',control_state:'human_private',revision:2,can_view:false})));
  assert.deepEqual(ops,['acquire','release']);
  assert.equal(ensures,1,'suspension must not launch another recovery');
  assert.ok(view.root.findByType('textarea').props.disabled);
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:true})));
  assert.deepEqual(ops,['acquire','release'],'foreground must not reacquire or return');
  assert.deepEqual(identities,['stable-viewer','stable-viewer']);
 }finally{if(view)await act(async()=>view.unmount());globalThis.fetch=original;globalThis.setInterval=intervals;globalThis.clearInterval=clear;}
});

test('mobile fits only explicitly, covers until matching drawn frame, and does not retry on resume', async () => {
 const originalFetch=globalThis.fetch, originalObserver=globalThis.ResizeObserver;
 const originalWindow=globalThis.window;
 const clients: Canvas[]=[];
 const writes: {path:string;body:Record<string,unknown>}[]=[];
 let width=390, height=740, rejectFit=false;
 class Canvas {
  frame={target_id:'page',document_id:'doc',frame_token:'frame',viewport_id:'old',width:1200,height:900,targets:[{target_id:'page',origin:'https://example.test'}]};
  closed=false;
  constructor(_canvas:unknown,_url:string,_viewer:string,readonly status:(state:string,targets:typeof this.frame.targets)=>void){clients.push(this)}
  show(){this.status('connected',this.frame.targets)}
  close(){this.closed=true}
 }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.ResizeObserver=class {constructor(_callback:()=>void){}observe(){}disconnect(){}} as unknown as typeof ResizeObserver;
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
  const fit=()=>view.root.findAllByType('button').find(b=>b.children.includes('Fit browser to this device'))!;
  assert.equal(fit().props.disabled,true);
  assert.equal(writes.length,0);
  await act(async()=>clients.at(-1)!.show());await settle();
  assert.equal(writes.length,0,'passive viewing does not resize');
  globalThis.window={innerHeight:800,visualViewport:{height:400}} as Window & typeof globalThis;
  await act(async()=>fit().props.onClick());await settle();
  assert.equal(writes.length,0,'keyboard-reduced Fit must not change remote geometry');
  assert.ok(JSON.stringify(view.toJSON()).includes('Dismiss the keyboard'));
  globalThis.window=originalWindow;
  await act(async()=>fit().props.onClick());await settle();
  assert.ok(JSON.stringify(view.toJSON()).includes('Fitting browser…'));
  await act(async()=>clients.at(-1)!.show());
  assert.ok(JSON.stringify(view.toJSON()).includes('Fitting browser…'),'old frame cannot reveal');
  await act(async()=>{clients.at(-1)!.frame.viewport_id='phone';clients.at(-1)!.show()});
  assert.equal(JSON.stringify(view.toJSON()).includes('Fitting browser…'),false);
  assert.deepEqual(writes[0].body,{width:390,height:740,viewer_id:'phone-viewer',target_id:'page',document_id:'doc'});
  assert.equal(clients.length,1);
  width=740;height=390;await settle();
  assert.equal(writes.length,1,'rotation does not resize');
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:false})));
  width=400;await settle();
  assert.equal(writes.length,1,'suspension must stop resizing');
  rejectFit=true;
  await act(async()=>view.update(createElement(BrowserViewer,{...props,active:true})));
  await act(async()=>clients.at(-1)!.show());await settle();
  assert.equal(writes.length,1,'resume does not resize');
  await act(async()=>fit().props.onClick());await settle();
  const current=clients.at(-1)!;
  assert.equal(current.closed,false,'fit failure must preserve passive media');
  assert.equal(JSON.stringify(view.toJSON()).includes('Fitting browser…'),false);
  await settle();assert.equal(writes.length,2,'uncertain fitting is not retried');
 }finally{if(view)await act(async()=>view.unmount());globalThis.fetch=originalFetch;globalThis.ResizeObserver=originalObserver;globalThis.window=originalWindow;}
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

test('mobile swipes target the finger origin and local zoom survives control callback updates', async()=>{
 const original=globalThis.fetch;
 const inputs:Record<string,number|string>[]=[];
 const clients:Canvas[]=[];
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'agent',revision:1,can_view:true,can_show_window:true};
 class Canvas {
  frame={target_id:'page',document_id:'doc',frame_token:'frame',viewport_id:'viewport',width:600,height:1200,targets:[{target_id:'page',origin:'https://example.test'}]};
  constructor(_canvas:unknown,_url:string,_viewer:string,readonly status:(state:string,targets:typeof this.frame.targets)=>void){clients.push(this)}
  show(){this.status('connected',this.frame.targets)} close(){}
 }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/input')){inputs.push(JSON.parse(String(init?.body)).input);return Response.json({focus_token:null})}
  if(String(url).endsWith('/control'))return Response.json({...metadata,override_id:'override',control_state:'human_private',revision:2,can_view:false});
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 const canvas=Object.assign(new EventTarget(),{style:{transform:'',touchAction:''},clientWidth:300,clientHeight:600,setPointerCapture(){},getBoundingClientRect:()=>({left:10,top:20,width:300,height:600})});
 const pointer=(type:string,id:number,x:number,y:number)=>canvas.dispatchEvent(Object.assign(new Event(type),{pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
 let view:ReactTestRenderer|undefined;
 try {
  await act(async()=>{view=create(createElement(BrowserViewer,{sessionId:'browser',mobile:true,active:true,embedded:true}),{createNodeMock:e=>e.type==='canvas'?canvas:e.type==='textarea'?{value:'',blur(){}}:null})});
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>view!.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.onClick());
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>{pointer('pointerdown',1,250,200);pointer('pointermove',1,251,160);pointer('pointerup',1,251,160)});
  assert.deepEqual(inputs,[{kind:'scroll',x:480,y:360,delta_y:80}]);
  await act(async()=>{pointer('pointerdown',1,50,100);pointer('pointerdown',2,150,100);pointer('pointermove',2,250,100);pointer('pointerup',2,250,100);pointer('pointerup',1,50,100)});
  assert.match(canvas.style.transform,/scale\(2\)/);
  // Return changes working/owns/send but does not dispose the mounted touch surface.
  await act(async()=>view!.root.findAllByType('button').find(b=>b.children.includes('Return to agent'))!.props.onClick());
  assert.match(canvas.style.transform,/scale\(2\)/);
  assert.equal(inputs.length,1,'pinch must not inject remote wheels');
 } finally {if(view)await act(async()=>view.unmount());globalThis.fetch=original}
});

test('rapid mobile gestures dispatch behind an in-flight wheel without queuing canceled momentum',async(t)=>{
 const original=globalThis.fetch, originalRaf=globalThis.requestAnimationFrame, originalCancel=globalThis.cancelAnimationFrame;
 let now=0, next=0;
 const callbacks=new Map<number,FrameRequestCallback>();
 t.mock.method(performance,'now',()=>now);
 globalThis.requestAnimationFrame=callback=>{callbacks.set(++next,callback);return next};
 globalThis.cancelAnimationFrame=id=>{callbacks.delete(id)};
 const inputs:{delta_y:number}[]=[], pending:((response:Response)=>void)[]=[], clients:Canvas[]=[];
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'agent',revision:1,can_view:true};
 class Canvas {
  frame={target_id:'page',document_id:'doc',frame_token:'frame',media_generation:'stream-generation',viewport_id:'viewport',width:600,height:1200,targets:[{target_id:'page',origin:'https://example.test'}]};
  constructor(_canvas:unknown,_url:string,_viewer:string,readonly status:(state:string,targets:typeof this.frame.targets)=>void){clients.push(this)}
  show(){this.status('connected',this.frame.targets)} close(){}
 }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/input')){inputs.push(JSON.parse(String(init?.body)).input);return new Promise(resolve=>pending.push(resolve))}
  if(String(url).endsWith('/control'))return Response.json({...metadata,override_id:'override',control_state:'human_private',revision:2,can_view:false});
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 const canvas=Object.assign(new EventTarget(),{style:{},clientWidth:300,clientHeight:600,setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:300,height:600})});
 const pointer=(type:string,y:number)=>canvas.dispatchEvent(Object.assign(new Event(type),{pointerType:'touch',pointerId:1,clientX:100,clientY:y}));
 const advance=(ms:number)=>{now+=ms;const ready=[...callbacks.values()];callbacks.clear();ready.forEach(cb=>cb(now))};
 let view:ReactTestRenderer|undefined;
 try {
  await act(async()=>{view=create(createElement(BrowserViewer,{sessionId:'browser',mobile:true,active:true,embedded:true}),{createNodeMock:e=>e.type==='canvas'?canvas:e.type==='textarea'?{value:'',blur(){}}:null})});
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>view!.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.onClick());
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>{pointer('pointerdown',400);advance(12);pointer('pointerup',300);advance(320)});
  assert.deepEqual(inputs.map(i=>i.delta_y),[200],'busy transport cannot dispatch momentum');
  await act(async()=>{pointer('pointerdown',400);advance(12);pointer('pointerup',250);advance(16)});
  assert.equal(inputs.length,1);
  await act(async()=>pending.shift()!(Response.json({focus_token:null})));
  assert.deepEqual(inputs.map(i=>i.delta_y),[200,300],'second gesture drains immediately after the first request');
  await act(async()=>pending.shift()!(Response.json({focus_token:null})));
  assert.equal(inputs.length,2,'old momentum was never queued');
  await act(async()=>advance(16));
  assert.equal(inputs.length,3,'new flick continues once transport is idle');
  await act(async()=>{pointer('pointerdown',200);pointer('pointerup',200)});
  await act(async()=>pending.shift()!(Response.json({focus_token:null})));
  await act(async()=>advance(320));
  assert.equal(inputs.length,3,'tap-to-stop discards unsent tail');
  await act(async()=>{pointer('pointerdown',400);advance(12);pointer('pointerup',300)});
  const dispatched=inputs.length;
  await act(async()=>pending.shift()!(Response.json({error:'browser_input_uncertain'},{status:409})));
  assert.match(view!.root.findByProps({role:'alert'}).children.join(''), /browser_input_uncertain; scroll; screencast; \d+ ms/);
  assert.equal(view!.root.findByType('textarea').props.disabled,true);
  await act(async()=>advance(320));
  assert.equal(inputs.length,dispatched,'uncertain input stops momentum without replay');
 } finally {
  if(view)await act(async()=>view.unmount());
  globalThis.fetch=original;globalThis.requestAnimationFrame=originalRaf;globalThis.cancelAnimationFrame=originalCancel;
 }
});

test('mobile keyboard opens only for confirmed editable clicks and fences late native focus', async () => {
 const original=globalThis.fetch;
 const inputs:Record<string,unknown>[]=[];
 const clients:Canvas[]=[];
 let focused=0, blurred=0;
 const keyboardRequests:(()=>void)[]=[];
 let acknowledge!: (response:Response)=>void;
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'agent',revision:1,can_view:true};
 class Canvas {
  frame={target_id:'page',document_id:'doc',frame_token:'frame',media_generation:'stream',width:600,height:1200,targets:[]};
  constructor(_canvas:unknown,_url:string,_viewer:string,readonly status:(state:string,targets:typeof this.frame.targets)=>void){clients.push(this)}
  show(){this.status('connected',this.frame.targets)} close(){}
 }
 Object.assign(globalThis,{__mobileCanvas:Canvas});
 globalThis.fetch=async(url,init)=>{
  if(String(url).endsWith('/input')) {
   inputs.push(JSON.parse(String(init?.body)).input);
   if(inputs.length===1)return new Promise(resolve=>{acknowledge=resolve});
   return Response.json({focus_token:'next-focus',focus_editable:inputs.length>=4});
  }
  if(String(url).endsWith('/control'))return Response.json({...metadata,override_id:'override',control_state:'human_private',revision:2,can_view:false});
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 const canvas=Object.assign(new EventTarget(),{style:{},clientWidth:300,clientHeight:600,setPointerCapture(){},getBoundingClientRect:()=>({left:10,top:20,width:300,height:600})});
 const keyboard=Object.assign(new EventTarget(),{value:'',selectionStart:0,selectionEnd:0,
  blur(){blurred++},focus(){focused++},setSelectionRange(a:number,b:number){this.selectionStart=a;this.selectionEnd=b}});
 let view:ReactTestRenderer|undefined;
 try {
  await act(async()=>{view=create(createElement(BrowserViewer,{sessionId:'browser',mobile:true,active:true,embedded:true,onKeyboardRequest:(show:()=>void)=>keyboardRequests.push(show)}),{createNodeMock:e=>e.type==='canvas'?canvas:e.type==='textarea'?keyboard:null})});
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>view!.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.onClick());
  await act(async()=>clients.at(-1)!.show());
  await act(async()=>view!.root.findByType('canvas').props.onClick({clientX:110,clientY:170}));
  assert.deepEqual(inputs,[{kind:'click',x:200,y:300}]);
  assert.equal(focused,0,'tap must not summon keyboard while remote click is pending');
  await act(async()=>acknowledge(Response.json({focus_token:'selected-field'})));
  assert.equal(focused,0,'a focus token alone does not prove an editable field');
  await act(async()=>view!.root.findByProps({'aria-label':'Show keyboard'}).props.onClick());
  assert.equal(focused,1);
  await act(async()=>view!.root.findByType('textarea').props.onChange({nativeEvent:{isComposing:false},target:{value:'test'}}));
  assert.deepEqual(inputs[1],{kind:'text',text:'test',focus_token:'selected-field'});
  const before=blurred;
  await act(async()=>view!.root.findByType('canvas').props.onClick({clientX:60,clientY:70}));
  assert.deepEqual(inputs[2],{kind:'click',x:100,y:100});
  assert.equal(blurred,before+1,'next page tap dismisses the local keyboard');
  assert.equal(focused,1,'next page tap must not reopen it');
  await act(async()=>view!.root.findByType('canvas').props.onClick({clientX:60,clientY:70}));
  assert.equal(keyboardRequests.length,1,'editable ACK requests native keyboard');
  assert.equal(focused,1,'wait for host callback');
  await act(async()=>keyboardRequests[0]());
  assert.equal(focused,2);
  await act(async()=>view!.root.findByType('canvas').props.onClick({clientX:60,clientY:70}));
  await act(async()=>keyboardRequests[0]());
  assert.equal(focused,2,'old tap cannot focus after a newer tap');
  const area=()=>view!.root.findByType('textarea');
  const sentinel=' ';
  assert.equal(keyboard.value,sentinel);
  const offset=inputs.length;
  await act(async()=>{keyboard.value=sentinel+'ab';area().props.onChange({nativeEvent:{isComposing:false},target:keyboard})});
  assert.equal(keyboard.value,sentinel);
  assert.equal(keyboard.selectionStart,1);
  // Simulate a software keyboard that only emits deletion with local content.
  for(let i=0;i<3;i++) await act(async()=>{
   assert.equal(keyboard.value,sentinel,'keep deletion context even past remote empty');
   const event=Object.assign(new Event('beforeinput',{cancelable:true}),{inputType:'deleteContentBackward',isComposing:false});
   keyboard.dispatchEvent(event);
   assert.equal(event.defaultPrevented,false,'allow WebKit to perform the local deletion');
   area().props.onKeyDown({key:'Backspace',nativeEvent:{isComposing:false},preventDefault(){assert.fail('mobile deletion must remain native')}});
   keyboard.value='';
   area().props.onChange({nativeEvent:{inputType:'deleteContentBackward',isComposing:false},target:keyboard});
  });
  assert.deepEqual(inputs.slice(offset).map(i=>[i.kind,i.text??i.key]),[
   ['text','ab'],['key','Backspace'],['key','Backspace'],['key','Backspace']
  ],'one remote deletion per gesture, no sentinel transmitted');
  // Some keyboards omit beforeinput; the completed input still carries intent.
  const beforeInputOnly=inputs.length;
  await act(async()=>{
   keyboard.value='';
   area().props.onChange({nativeEvent:{inputType:'deleteContentBackward',isComposing:false},target:keyboard});
  });
  assert.equal(inputs.length,beforeInputOnly+1);
  assert.equal(inputs.at(-1)!.key,'Backspace');
  assert.equal(keyboard.value,sentinel);
  const beforeComposition=inputs.length;
  await act(async()=>{keyboard.value=sentinel+'文';area().props.onChange({nativeEvent:{isComposing:true},target:keyboard})});
  assert.equal(inputs.length,beforeComposition);
  assert.equal(keyboard.value,sentinel+'文');
  await act(async()=>area().props.onCompositionEnd({currentTarget:keyboard}));
  assert.equal(inputs.at(-1)!.text,'文');
  assert.equal(keyboard.value,sentinel);

  await act(async()=>view!.update(createElement(BrowserViewer,{sessionId:'browser',mobile:true,active:false,embedded:true})));
  await act(async()=>keyboardRequests.at(-1)!());
  assert.equal(focused,2,'suspension fences native focus');
 } finally {if(view)await act(async()=>view.unmount());globalThis.fetch=original;}
});

test('reopened private viewer shows saved agent pixels without control and fences late snapshots', async () => {
 const original = globalThis.fetch;
 let loads=0, mediaCount=0;
 const writes:string[]=[];
 const metadata={session_id:'browser',thread_id:'thread',bud_id:'bud',generation:'gen',state:'ready',control_state:'paused',revision:2,can_view:false};
 let pending:((response:Response)=>void)|undefined;
 let delay=false, denied=false;
 Object.assign(globalThis,{__mobileCanvas:class {constructor(){mediaCount++}close(){}}});
 globalThis.fetch=async(url,init)=>{
  if(denied)return Response.json({error:'unauthorized'},{status:401});
  if(String(url).endsWith('/shared-frame')) {
   loads++;
   if(delay)return new Promise(resolve=>{pending=resolve});
   return Response.json({snapshot:{image:'cHVibGlj',mime_type:'image/png',captured_at:Date.now()}});
  }
  if(init?.method==='POST')writes.push(String(url).split('/').at(-1)!);
  return Response.json(metadata);
 };
 const {BrowserViewer}=await import('./viewer');
 const props={sessionId:'browser',mobile:true,embedded:true};
 const canvas=Object.assign(new EventTarget(),{style:{}});
 let view:ReactTestRenderer|undefined;
 try {
  await act(async()=>{view=create(createElement(BrowserViewer,props),{createNodeMock:e=>e.type==='canvas'?canvas:null})});
  assert.equal(view.root.findByType('img').props.src,'data:image/png;base64,cHVibGlj');
  assert.match(JSON.stringify(view.toJSON()),/Last agent view/);
  assert.equal(view.root.findByType('textarea').props.disabled,true);
  assert.equal(mediaCount,0);
  assert.deepEqual(writes,['ensure']);
  await act(async()=>StateSocket.change());
  assert.equal(loads,1,'unchanged metadata must not poll images');
  await act(async()=>view!.update(createElement(BrowserViewer,{...props,active:false})));
  assert.equal(view.root.findAllByType('img').length,0);
  delay=true;
  await act(async()=>view!.update(createElement(BrowserViewer,{...props,active:true})));
  assert.ok(pending);
  await act(async()=>view!.update(createElement(BrowserViewer,{...props,active:false})));
  await act(async()=>pending!(Response.json({snapshot:{image:'late',mime_type:'image/png',captured_at:Date.now()}})));
  assert.equal(view.root.findAllByType('img').length,0);
  assert.equal(mediaCount,0);
  assert.ok(writes.every(write=>write==='ensure'),'no acquire, return, input or fit');
  delay=false;
  await act(async()=>view!.update(createElement(BrowserViewer,{...props,active:true})));
  assert.equal(view.root.findAllByType('img').length,1);
  denied=true;
  await act(async()=>StateSocket.change());
  assert.equal(view.root.findAllByType('img').length,0,'authorization loss clears saved pixels');
 } finally {if(view)await act(async()=>view.unmount());globalThis.fetch=original;}
});
