import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {WebSocket} from 'ws';
import {attachBrowserState} from './state-stream.js';
import type {BrowserStateEvents, BrowserStateHint} from './state-events.js';

class Socket extends EventEmitter {
  readyState=1; bufferedAmount=0; messages:{type:string;revision:number}[]=[]; code=0;
  send(value:string){this.messages.push(JSON.parse(value));}
  close(code:number){this.code=code;this.readyState=3;this.emit('close');}
  terminate(){this.close(1006);}
  ping(){this.emit('pong');}
}
function bus(){
  const listeners=new Set<(hint:BrowserStateHint)=>void>();
  let lost=()=>{};
  return {listeners,ready:async()=>{},subscribe(change:(h:BrowserStateHint)=>void, loss:()=>void){
    listeners.add(change);lost=loss;return ()=>listeners.delete(change);
  },publish(h:BrowserStateHint){for(const f of listeners)f(h);},lose(){lost();}};
}
test('denied scope never subscribes; live owner/grant loss closes before delivering a hint',async()=>{
  const events=bus(), denied=new Socket();
  await attachBrowserState(denied as unknown as WebSocket,events as unknown as BrowserStateEvents,{bud_id:'A'},async()=>false);
  assert.equal(denied.code,4404);assert.equal(events.listeners.size,0);assert.equal(denied.messages.length,0);
  let allowed=true;
  const socket=new Socket();
  await attachBrowserState(socket as unknown as WebSocket,events as unknown as BrowserStateEvents,{bud_id:'A',thread_id:'thread'},async()=>allowed);
  assert.deepEqual(socket.messages,[{type:'ready',revision:0}]);
  events.publish({bud_id:'B'});events.publish({bud_id:'A',thread_id:'another-thread'});
  await Promise.resolve();assert.equal(socket.messages.length,1);
  events.publish({bud_id:'A'});await Promise.resolve();assert.equal(socket.messages.at(-1)?.type,'changed');
  allowed=false;events.publish({bud_id:'A'});await Promise.resolve();
  assert.equal(socket.code,4404);assert.equal(socket.messages.length,2);assert.equal(events.listeners.size,0);
});
test('heartbeat is transport only; separate expiry check and listener loss clean up',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date']});
  const events=bus(),socket=new Socket();let checks=0;
  await attachBrowserState(socket as unknown as WebSocket,events as unknown as BrowserStateEvents,{bud_id:'A'},async()=>{checks++;return true;});
  t.mock.timers.tick(15_000);assert.equal(checks,1);assert.equal(socket.messages.at(-1)?.type,'heartbeat');
  t.mock.timers.tick(15_000);await Promise.resolve();assert.equal(checks,2);
  events.lose();assert.equal(socket.code,1006);assert.equal(events.listeners.size,0);
  t.mock.timers.tick(60_000);assert.equal(checks,2);
});
