import test from "node:test";
import assert from "node:assert/strict";
import {register} from "node:module";
import {act, createElement} from "react";
import {create, type ReactTestRenderer} from "react-test-renderer";
register(`data:text/javascript,${encodeURIComponent(`export async function load(url,context,next){
 if(url.endsWith('/features/browser/viewer.tsx'))return {format:'module',source:'export function BrowserViewer(){return null}',shortCircuit:true};
 if(url.endsWith('/components/theme-provider.tsx'))return {format:'module',source:'export function ThemeProvider({children}){return children}',shortCircuit:true};
 return next(url,context);
}`)}`,import.meta.url);
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});

test("mobile bridge validates identity before ready and rejects unsupported commands; stale lifecycle ACKs cannot uncover", async () => {
  const keys=["location","window","document","requestAnimationFrame"] as const;
  const saved=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
  const session="browser_01M2PDAA5JH32J0YNYJXDSTV9Z", visit="01M2PDAA5JH32J0YNYJXDSTV9Z";
  const query="?viewer_id=00000000-0000-4000-8000-000000000001&visit_id="+visit;
  const messages: Record<string,unknown>[]=[];
  const frames: (()=>void)[]=[];
  const win={webkit:{messageHandlers:{budBrowser:{postMessage:(body:Record<string,unknown>)=>messages.push(body)}}},
    budBrowserCommand:undefined as undefined|((body:unknown)=>void)};
  const doc=Object.assign(new EventTarget(),{hidden:false});
  Object.assign(globalThis,{window:win, document:doc,location:{pathname:"/browser-mobile/"+session,search:query,hash:""},
    requestAnimationFrame:(callback:()=>void)=>{frames.push(callback);return frames.length;}});
  const {MobileBrowserEntry}=await import("./mobile");
  let view: ReactTestRenderer|undefined;
  const flush=()=>{while(frames.length)frames.shift()!();};
  try {
    for(const search of [query+"&visit_id="+visit, query.replace("00000000-0000-4000-8000-000000000001","------------------------------------"),query+"&extra=1"]) {
      globalThis.location.search=search;
      await act(async()=>{view=create(createElement(MobileBrowserEntry));});
      assert.equal(win.budBrowserCommand,undefined);
      assert.equal(messages.length,0);
      await act(async()=>view!.unmount());
    }
    globalThis.location.search=query;
    await act(async()=>{view=create(createElement(MobileBrowserEntry));});
    assert.equal(messages[0].event,"ready");
    const command=(name:string,id:string)=>win.budBrowserCommand!({version:1,visit_id:visit,request_id:id,command:name});
    await act(async()=>command("return_to_agent","unsupported"));
    assert.deepEqual(messages.at(-1),{version:1,visit_id:visit,event:"result",request_id:"unsupported",accepted:false});
    await act(async()=>{command("resume","resume");command("suspend","suspend");flush();});
    assert.equal(messages.find(m=>m.request_id==="resume")?.accepted,false);
    assert.equal(messages.find(m=>m.request_id==="suspend")?.accepted,true);
    const count=messages.length;
    await act(async()=>command("suspend","suspend"));
    assert.equal(messages.length,count,"duplicate ID ignored");
    await act(async()=>command("resume","late"));
    await act(async()=>view!.unmount());
    flush();
    assert.equal(messages.length,count,"disposed bridge cannot publish a late ACK");
  } finally {
    if(view)await act(async()=>view!.unmount());
    keys.forEach((key,i)=>{if(saved[i])Object.defineProperty(globalThis,key,saved[i]!);else Reflect.deleteProperty(globalThis,key);});
  }
});
