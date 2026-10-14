import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { register } from 'node:module';
import { StateSocket } from './state-feed.fixture';
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { BrowserControls } = await import('./controls');
const { BrowserStateFeed } = await import('./state-feed');
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
beforeEach(() => { StateSocket.all = []; globalThis.WebSocket = StateSocket as unknown as typeof WebSocket; });
afterEach(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });

for (const mobile of [false, true]) test(`contextual options are presentation-only and hide unsupported controls (${mobile ? 'mobile' : 'desktop'})`, async () => {
  const actions: string[] = [];
  const feed = new BrowserStateFeed('/api/browser/sessions/browser/state');
  let open = false, owns = false;
  const targets = [{ target_id: "one", origin: "https://example.test" }];
  let focused = 0;
  globalThis.fetch = async () => { assert.fail('options must not read browser management'); };
  const props = () => ({ sessionId: 'browser', budId: 'bud', threadId: 'thread', stateFeed: feed,
    mobile, embedded: true, active: true, owns, busy: false, canTake: true,
    canSelect: true, canFit: true, fitSupported: false, canShow: true, status: 'Watching agent',
    targets, selectedTarget: 'one', open,
    onOpenChange: (next: boolean) => { open = next; },
    onTake: () => actions.push('take'), onReturn: () => actions.push('return'),
    onFit: () => actions.push('fit'), onSelect: (id: string) => actions.push(`select:${id}`),
    onShow: () => actions.push('show'), onHide: () => actions.push('hide'),
    onCloseTabs: () => actions.push('close'), onDismiss: () => actions.push('dismiss') });
  let view!: ReactTestRenderer;
  const click = async (label: string) => act(async () => {
    view.root.findAllByType('button').find(b => b.children.includes(label))!.props.onClick();
    view.update(createElement(BrowserControls, props()));
  });
  try {
    await act(async () => { view = create(createElement(BrowserControls, props()), {createNodeMock: e => e.type === 'button' ? {focus() {focused++;}} : null}); });
    const toolbar = view.root.findByProps({'aria-label': 'Browser toolbar'});
    assert.equal(toolbar.findAllByType('button').filter(b => b.children.includes('Take control')).length, 1);
    assert.equal(toolbar.findAllByProps({'aria-label': 'Dismiss browser pane'}).length, 0);
    assert.equal(toolbar.findAllByType('h1').length, 0, 'native supplies mobile title');
    assert.equal(view.root.findAllByType('select').length, 0);
    assert.equal(view.root.findAllByType('button').some(b => b.children.includes('Switch page…') || b.children.includes('Fit to this device')), false);
    await act(async () => { view.root.findByProps({'aria-label':'More browser options'}).props.onClick(); view.update(createElement(BrowserControls,props())); });
    assert.equal(view.root.findByProps({role:'dialog'}).props.hidden, false);
    assert.equal(view.root.findAllByType('button').some(b=>b.children.includes('Browser settings…')), !mobile);
    assert.equal(view.root.findAllByType('button').some(b=>b.children.includes('Show on Bud’s machine…')), !mobile);
    await act(async () => { view.root.findByProps({'aria-label':'Close browser options'}).props.onClick(); view.update(createElement(BrowserControls,props())); });
    assert.equal(view.root.findByProps({role:'dialog'}).props.hidden, true);
    assert.equal(focused, 1, 'dismissal restores only the options trigger');
    assert.deepEqual(actions, []);
    await click('Take control');
    assert.deepEqual(actions, ['take']);
    owns = true;
    targets.push({target_id:'two', origin:'https://second.test'});
    await act(async () => view.update(createElement(BrowserControls,props())));
    await act(async () => { view.root.findByProps({'aria-label':'More browser options'}).props.onClick(); view.update(createElement(BrowserControls,props())); });
    await click('Switch page…');
    await click('https://second.test');
    assert.equal(open,false);
    await click('Return to agent');
    assert.deepEqual(actions, ['take','select:two','return']);
  } finally { if(view) await act(async()=>view.unmount()); }
});

test('management reads only on entry and thread tab closure requires explicit confirmation', async () => {
  const requests: {url:string; body?:unknown}[] = [];
  globalThis.fetch = async (url, init) => { requests.push({url:String(url),body:init?.body}); return Response.json({browser:{browser_id:'resource',revision:1,desired_state:'open'}}); };
  const feed = new BrowserStateFeed('/api/browser/sessions/browser/state');
  let open = false, closed = 0;
  const props = () => ({ sessionId:'browser',budId:'bud',stateFeed:feed,mobile:false,embedded:true,active:true,owns:false,busy:false,canTake:true,
    canSelect:false,canFit:false,fitSupported:false,canShow:false,status:'Watching agent',targets:[],selectedTarget:'',open,onOpenChange:(next:boolean)=>{open=next;},
    onTake(){},onReturn(){},onFit(){},onSelect(){},onShow(){},onHide(){},onCloseTabs(){closed++;} });
  let view!:ReactTestRenderer;
  const click = async (label:string) => act(async()=>{view.root.findAllByType('button').find(b=>b.children.includes(label))!.props.onClick();view.update(createElement(BrowserControls,props()));});
  const menu = async () => act(async()=>{view.root.findByProps({'aria-label':'More browser options'}).props.onClick();view.update(createElement(BrowserControls,props()));});
  try {
    await act(async()=>{view=create(createElement(BrowserControls,props()));});
    assert.equal(requests.length,0);
    await menu();assert.equal(requests.length,0);
    await click('Browser settings…');
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,'/api/buds/bud/browser');
    await click('Close this thread’s browser tabs…');
    assert.equal(closed,0);
    await click('Cancel');assert.equal(closed,0);
    await click('Close this thread’s browser tabs…');await click('Close tabs');
    assert.equal(closed,1);assert.equal(open,false);
    assert.equal(StateSocket.all[0].closed,true,'settings reader disposes when options close');
    await menu();await click('Browser settings…');
    assert.equal(requests.length,2,'new settings entry reads fresh status');
    assert.equal(requests.every(r=>!r.body),true,'settings entry/confirmation cancel do not mutate');
  } finally { if(view)await act(async()=>view.unmount()); }
});

test('Escape, outside dismissal and Tab cycling restore toolbar focus without a page action', async () => {
  const originalDocument = globalThis.document;
  const doc = Object.assign(new EventTarget(), {activeElement:null as unknown});
  globalThis.document = doc as unknown as Document;
  const first = {focus() {doc.activeElement=first;}}, last = {focus() {doc.activeElement=last;}};
  const trigger = {focus() {doc.activeElement=trigger;}};
  const content = {querySelectorAll() {return [first,last];},contains(node:unknown) {return node===first || node===last;}};
  let open=false;
  const onOpenChange=(next:boolean)=>{open=next;};
  const props=()=>({sessionId:'browser',stateFeed:new BrowserStateFeed('/state'),mobile:false,embedded:true,active:true,owns:false,busy:false,canTake:false,canSelect:false,canFit:false,fitSupported:false,canShow:false,
    status:'In use in another view',targets:[],selectedTarget:'',open,onOpenChange,
    onTake(){assert.fail('no takeover');},onReturn(){assert.fail('no return');},onFit(){},onSelect(){},onShow(){},onHide(){},onCloseTabs(){}});
  let view!:ReactTestRenderer;
  const menu=async()=>act(async()=>{view.root.findByProps({'aria-label':'More browser options'}).props.onClick();view.update(createElement(BrowserControls,props()));});
  const key=async(name:string,shiftKey=false)=>{
    const event=Object.assign(new Event('keydown',{cancelable:true}),{key:name,shiftKey});
    await act(async()=>{doc.dispatchEvent(event);view.update(createElement(BrowserControls,props()));});
    return event;
  };
  try {
    await act(async()=>{view=create(createElement(BrowserControls,props()),{createNodeMock:e=>e.type==='section'?content:e.type==='button'&&e.props['aria-label']==='More browser options'?trigger:null});});
    assert.equal(view.root.findAllByType('button').find(b=>b.children.includes('Take control'))!.props.disabled,true);
    await menu();assert.equal(doc.activeElement,first);
    doc.activeElement=last;
    assert.equal((await key('Tab')).defaultPrevented,true);assert.equal(doc.activeElement,first);
    assert.equal((await key('Tab',true)).defaultPrevented,true);assert.equal(doc.activeElement,last);
    await key('Escape');assert.equal(open,false);assert.equal(doc.activeElement,trigger);
    await menu();
    const backdrop=view.root.findAllByType('div').find(d=>d.props.onPointerDown)!;
    const target={};
    await act(async()=>{backdrop.props.onPointerDown({target,currentTarget:target});view.update(createElement(BrowserControls,props()));});
    assert.equal(open,false);assert.equal(doc.activeElement,trigger);
  } finally {if(view)await act(async()=>view.unmount());globalThis.document=originalDocument;}
});
