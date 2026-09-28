import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserTouch } from './touch.ts';

test('tap, remote swipe and local pinch/pan remain distinct; drag cannot click', () => {
  const canvas = Object.assign(new EventTarget(), {style:{transform:'',touchAction:''},clientWidth:300,clientHeight:600,setPointerCapture() {}});
  const scrolls:number[]=[];
  const stop=installBrowserTouch(canvas as unknown as HTMLCanvasElement, delta=>{scrolls.push(delta)});
  const pointer=(type:string,id:number,x:number,y:number)=>canvas.dispatchEvent(Object.assign(new Event(type),{pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
  pointer('pointerdown',1,50,200);pointer('pointermove',1,51,201);pointer('pointerup',1,51,201);
  assert.equal(canvas.dispatchEvent(new Event('click',{cancelable:true})),true);
  assert.deepEqual(scrolls,[]);
  pointer('pointerdown',1,50,200);pointer('pointermove',1,50,150);pointer('pointerup',1,50,150);
  assert.deepEqual(scrolls,[50]);
  assert.equal(canvas.dispatchEvent(new Event('click',{cancelable:true})),false);
  pointer('pointerdown',1,50,100);pointer('pointerdown',2,150,100);pointer('pointermove',2,250,100);
  assert.match(canvas.style.transform,/scale\(2\)/);
  pointer('pointerup',2,250,100);pointer('pointermove',1,60,140);
  assert.deepEqual(scrolls,[50]);
  stop();assert.equal(canvas.style.transform,'');assert.equal(canvas.style.touchAction,'');
  pointer('pointermove',1,60,240);assert.deepEqual(scrolls,[50]);
});

function fixture() {
  const canvas=Object.assign(new EventTarget(), {style:{transform:'',touchAction:''},clientWidth:300,clientHeight:600,setPointerCapture(){}});
  const scrolls:{delta:number;point:{clientX:number;clientY:number}}[]=[];
  let identity='page:doc:viewport';
  const stop=installBrowserTouch(canvas as unknown as HTMLCanvasElement,(delta,point)=>{scrolls.push({delta,point})},()=>identity);
  const pointer=(type:string,id:number,x=0,y=0)=>canvas.dispatchEvent(Object.assign(new Event(type),{pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
  const click=()=>canvas.dispatchEvent(new Event('click',{cancelable:true}));
  return {canvas,scrolls,stop,pointer,click,change:()=>{identity='new-page'}};
}

test('remote swipe retains off-center start point for nested scrolling and queue coalescing',()=>{
  const f=fixture();
  try {
    f.pointer('pointerdown',1,240,180);
    f.pointer('pointermove',1,242,140);f.pointer('pointermove',1,244,100);
    f.pointer('pointerup',1,244,100);f.pointer('pointermove',1,244,50);
    assert.deepEqual(f.scrolls,[{delta:40,point:{clientX:240,clientY:180}},{delta:40,point:{clientX:240,clientY:180}}]);
    assert.equal(f.click(),false);
  } finally {f.stop()}
});

test('stationary pinch and cancellation cannot turn into remote clicks',()=>{
  for(const type of ['pointercancel','lostpointercapture','pinch']) {
    const f=fixture();
    try {
      f.pointer('pointerdown',1,50,100);
      if(type==='pinch') {f.pointer('pointerdown',2,100,100);f.pointer('pointerup',2,100,100)}
      else f.pointer(type,1);
      f.pointer('pointerup',1,50,100);
      assert.equal(f.click(),false,type);
      assert.deepEqual(f.scrolls,[]);
    } finally {f.stop()}
  }
  const f=fixture();
  try {
    f.pointer('pointerdown',1,50,100);f.pointer('pointerup',1,50,100);f.pointer('lostpointercapture',1);
    assert.equal(f.click(),true,'normal implicit capture release must not suppress a tap');
  } finally {f.stop()}
});

test('document change cancels an in-flight swipe and suppresses an obsolete tap',()=>{
  const f=fixture();
  try {
    f.pointer('pointerdown',1,200,200);f.change();f.pointer('pointermove',1,200,100);
    assert.deepEqual(f.scrolls,[]);assert.equal(f.click(),false);
    assert.match(f.canvas.style.transform,/scale\(1\)/);
  } finally {f.stop()}
});

function momentumFixture(maximum = Infinity) {
  const canvas=Object.assign(new EventTarget(), {style:{transform:'',touchAction:''},clientWidth:300,clientHeight:600,setPointerCapture(){}});
  let now=0, next=0, identity='page', busy=false, allowed=true;
  const tasks=new Map<number,()=>void>();
  const scrolls:{delta:number;momentum:boolean}[]=[];
  const stop=installBrowserTouch(canvas as unknown as HTMLCanvasElement,(delta,_point,momentum)=>{
    if(!allowed) return false;
    if(momentum && busy) return 'busy';
    const consumed=momentum ? Math.min(Math.abs(delta),maximum) : Math.abs(delta);
    scrolls.push({delta:Math.sign(delta)*consumed,momentum});
    return consumed;
  },()=>identity,{now:()=>now,request:cb=>{tasks.set(++next,cb);return next},cancel:id=>{tasks.delete(id)}});
  const advance=(ms:number)=>{now+=ms;const callbacks=[...tasks.values()];tasks.clear();callbacks.forEach(cb=>cb());};
  const pointer=(type:string,y=100,id=1)=>canvas.dispatchEvent(Object.assign(new Event(type),{pointerType:'touch',pointerId:id,clientX:100,clientY:y}));
  const flick=()=>{pointer('pointerdown',200);advance(40);pointer('pointermove',160);advance(40);pointer('pointermove',100);pointer('pointerup',100);};
  return {canvas,scrolls,stop,advance,pointer,flick,tasks,change:()=>{identity='new'},busy:(value:boolean)=>{busy=value},deny:()=>{allowed=false}};
}

test('fast flick decays with bounded extra travel; direct drag distance is unchanged',()=>{
  const f=momentumFixture();
  try {
    f.flick();
    assert.deepEqual(f.scrolls.map(s=>s.delta),[40,60]);
    for(let i=0;i<230;i++) f.advance(16);
    const tail=f.scrolls.filter(s=>s.momentum).map(s=>s.delta);
    assert.ok(tail.length>10);
    assert.ok(tail[0]>tail.at(-1)!);
    assert.ok(tail.reduce((a,b)=>a+b,0)>300);
    assert.ok(tail.reduce((a,b)=>a+b,0)<1000);
    assert.equal(f.tasks.size,0);
  } finally {f.stop()}
});

test('slow drag, release after holding, and pinch do not generate momentum',()=>{
  for(const mode of ['slow','hold','pinch']) {
    const f=momentumFixture();
    try {
      f.pointer('pointerdown',200);f.advance(50);f.pointer('pointermove',mode==='slow'?190:150);
      if(mode==='hold') f.advance(100);
      if(mode==='pinch') {f.pointer('pointerdown',100,2);f.pointer('pointerup',100,2)}
      f.pointer('pointerup',mode==='slow'?190:150);f.advance(16);
      assert.equal(f.scrolls.some(s=>s.momentum),false,mode);
    } finally {f.stop()}
  }
});

test('new touch, cancellation, changed identity, denied input and suspension stop momentum',()=>{
  for(const mode of ['touch','pointercancel','identity','denied','suspended','cleanup']) {
    const f=momentumFixture();
    f.flick();f.advance(16);
    const count=f.scrolls.length;
    if(mode==='touch') {f.pointer('pointerdown');f.pointer('pointerup');assert.equal(f.canvas.dispatchEvent(new Event('click',{cancelable:true})),false)}
    if(mode==='pointercancel') f.pointer('pointercancel');
    if(mode==='identity') f.change();
    if(mode==='denied') f.deny();
    if(mode==='cleanup') f.stop();
    f.advance(mode==='suspended'?1100:16);f.advance(16);
    assert.equal(f.scrolls.length,count,mode);
    assert.equal(f.tasks.size,0,mode);
    f.stop();
  }
});

test('busy transport holds only bounded movement and a new touch discards it',()=>{
  const f=momentumFixture();
  try {
    f.flick();f.busy(true);
    for(let i=0;i<20;i++) f.advance(16);
    assert.equal(f.scrolls.length,2);
    f.busy(false);f.advance(16);
    assert.ok(f.scrolls.at(-1)!.delta>120,'busy movement must not be clipped');
    f.busy(true);f.advance(16);f.pointer('pointerdown');f.pointer('pointerup');
    f.busy(false);f.advance(16);
    assert.equal(f.scrolls.length,3);
  } finally {f.stop()}
});

test('recent reversal determines momentum direction',()=>{
  const f=momentumFixture();
  try {
    f.pointer('pointerdown',200);f.advance(30);f.pointer('pointermove',100);
    f.advance(30);f.pointer('pointermove',130);f.pointer('pointerup',130);f.advance(16);
    assert.ok(f.scrolls.at(-1)!.momentum);
    assert.ok(f.scrolls.at(-1)!.delta<0);
  } finally {f.stop()}
});

test('a fast flick spans multiple screen heights with comparable distance under latency',()=>{
  const run=(latency:number)=>{
    const f=momentumFixture();
    try {
      f.pointer('pointerdown',500);f.advance(40);f.pointer('pointermove',300);
      f.pointer('pointerup',300);
      // Requests in flight, including the final direct drag, delay admission.
      for(let i=1;i<=225;i++) {
        f.busy((i*16)%latency>=16);
        f.advance(16);
      }
      assert.equal(f.tasks.size,0);
      return f.scrolls.reduce((total,s)=>total+s.delta,0);
    } finally {f.stop()}
  };
  const fast=run(16), delayed=run(320);
  assert.ok(fast>=1800 && fast<=2000.001,`200px drag plus at most three 600px screens: ${fast}`);
  assert.ok(Math.abs(fast-delayed)<2,`${fast} versus ${delayed}`);
});

test('a quick up-only flick and an immediate follow-up both deliver movement',()=>{
  const f=momentumFixture();
  try {
    f.pointer('pointerdown',400);f.advance(12);f.pointer('pointerup',300);
    assert.deepEqual(f.scrolls,[{delta:100,momentum:false}]);
    f.advance(16);
    assert.equal(f.scrolls.at(-1)!.momentum,true);
    f.busy(true);
    f.pointer('pointerdown',400);f.advance(12);f.pointer('pointerup',250);
    assert.deepEqual(f.scrolls.at(-1),{delta:150,momentum:false});
    f.busy(false);f.advance(16);
    assert.equal(f.scrolls.at(-1)!.momentum,true);
    assert.ok(f.scrolls.at(-1)!.delta>0);
  } finally {f.stop()}
});

test('a moderate rendering stall does not kill momentum',()=>{
  const f=momentumFixture();
  try {
    f.flick();f.advance(200);
    assert.equal(f.scrolls.at(-1)!.momentum,true);
    assert.ok(f.tasks.size>0);
  } finally {f.stop()}
});


test('partial wheel admission preserves the scaled viewport remainder',()=>{
  const f=momentumFixture(50);
  try {
    f.pointer('pointerdown',500);f.advance(40);f.pointer('pointerup',300);
    f.busy(true);
    for(let i=0;i<20;i++) f.advance(16);
    f.busy(false);
    for(let i=0;i<210;i++) f.advance(16);
    const tail=f.scrolls.filter(s=>s.momentum);
    assert.ok(tail.every(s=>Math.abs(s.delta)<=50));
    assert.ok(Math.abs(tail.reduce((n,s)=>n+s.delta,0)-1800)<2);
    assert.equal(f.tasks.size,0);
  } finally {f.stop()}
});
