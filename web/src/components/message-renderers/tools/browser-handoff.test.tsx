import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { register } from 'node:module'
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
const { BrowserHandoffContent } = await import('./browser-handoff')
const { BrowserWaitActionsContext } = await import('@/features/browser/pane')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
test('inline wait uses only its own mounted controller and stops its invocation', async () => {
  let returned = 0; let stopped = ''
  const sessionId = 'browser_01M2KFXEFBTPXR71B57JFBW9Z1'
  const payload = {pending:true,wait_kind:'return_control',invocation_id:'waiting',session_id:sessionId,viewer_path:`/browser/${sessionId}`}
  let tree!: ReturnType<typeof create>
  const render = (id: string, pending = true, visible = true) => <BrowserWaitActionsContext.Provider value={{
    visibleSessionId:visible ? sessionId : null,returnAction:{sessionId:id,disabled:false,returning:false,run:()=>{returned++}},error:null,stop:async id=>{stopped=id}
  }}><BrowserHandoffContent payload={{...payload,pending}} /></BrowserWaitActionsContext.Provider>
  await act(async()=>{tree=create(render(sessionId))})
  await act(async()=>{tree.root.findAllByType('button').find(b=>b.children.includes('Return to agent'))!.props.onClick()})
  assert.equal(returned,1)
  assert.equal(tree.root.findAllByType('a').length,0)
  assert.doesNotMatch(JSON.stringify(tree.toJSON()),/Browser needs|You can keep chatting|Browser work is waiting/)
  await act(async()=>{await tree.root.findAllByType('button').find(b=>b.children.includes('Cancel'))!.props.onClick()})
  assert.equal(stopped,'waiting')
  await act(async()=>tree.update(render('another')))
  assert.equal(tree.root.findAllByType('button').find(b=>b.children.includes('Return to agent'))!.props.disabled,true)
  await act(async()=>tree.update(render('another',true,false)))
  assert.equal(tree.root.findByType('a').children[0],'Open browser')
  await act(async()=>tree.update(render(sessionId,false)))
  assert.equal(tree.root.findAllByType('button').length,0)
  await act(async()=>tree.unmount())
})
