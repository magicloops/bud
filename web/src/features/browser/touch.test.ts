import test from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserTouch } from './touch.ts';

test('tap, remote swipe and local pinch/pan remain distinct; drag cannot click', () => {
  const canvas = Object.assign(new EventTarget(), {style:{transform:'',touchAction:''},clientWidth:300,clientHeight:600,setPointerCapture() {}});
  const scrolls:number[]=[];
  const stop=installBrowserTouch(canvas as unknown as HTMLCanvasElement, delta=>scrolls.push(delta));
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
