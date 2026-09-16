import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageArtifacts, hydrateBrowserImages } from './image-artifacts.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import type { CanonicalMessage } from '../llm/types.js';

test('images survive store recreation, preserve pairing and enforce owner/thread/call scope', async t => {
  const path = await mkdtemp(join(tmpdir(),'bud-images-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  const store = new ImageArtifacts(path);
  const artifact = await store.put({ owner:'alice',thread:'thread',bud:'bud',call:'call',session:'session',generation:'generation',epoch:1,target:'target',document:'document',image:'aW1hZ2U=',mime_type:'image/png' });
  const restarted = new ImageArtifacts(path);
  assert.ok(await restarted.get(artifact.id,'alice','thread','call'));
  assert.equal(await restarted.get(artifact.id,'bob','thread','call'),null);
  assert.equal(await restarted.get(artifact.id,'alice','other','call'),null);
  assert.equal(await restarted.get(artifact.id,'alice','thread','other'),null);
  assert.equal(await restarted.get('../anything','alice','thread'),null);
  const messages:CanonicalMessage[] = [{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:JSON.stringify({tool:'browser_observe',ok:true,data:{image_artifact:artifact}})}]}];
  const context = { ownerUserId:'alice',threadId:'thread',budId:'bud' };
  const hydrated = await hydrateBrowserImages(messages,context,true,restarted,async()=>true);
  assert.match(JSON.stringify(hydrated),/aW1hZ2U=/);
  assert.doesNotMatch(JSON.stringify(messages),/aW1hZ2U=/);
  for (const [vision, allowed] of [[false,true],[true,false]]) {
    const denied = await hydrateBrowserImages(messages,context,vision,restarted,async()=>allowed);
    assert.doesNotMatch(JSON.stringify(denied),/aW1hZ2U=/);
    assert.match(JSON.stringify(denied),/unavailable/);
  }
  const openai = new OpenAIProvider('fixture');
  const anthropic = new AnthropicProvider('fixture');
  const o = Reflect.get(openai, 'transformMessages').call(openai, hydrated) as any;
  assert.ok(o.some((m:any)=>m.content?.some((b:any)=>b.type === 'input_image' && b.image_url.endsWith('aW1hZ2U='))));
  const a = Reflect.get(anthropic, 'transformMessages').call(anthropic, hydrated) as any;
  assert.ok(a.anthropicMessages.some((m:any)=>m.content?.some((b:any)=>b.type === 'image' && b.source.data === 'aW1hZ2U=')));
  const repeated = Array.from({length:9},()=>structuredClone(messages[0]));
  const bounded = await hydrateBrowserImages(repeated,context,true,restarted,async()=>true);
  assert.equal(bounded.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type === 'image').length,8);
  await unlink(join(path,`${artifact.id}.json`));
  const missing = await hydrateBrowserImages(messages,context,true,restarted,async()=>true);
  assert.match(JSON.stringify(missing),/unavailable/);
  assert.doesNotMatch(JSON.stringify(missing),/aW1hZ2U=/);
  assert.equal(await restarted.get('1-01M2KFXEFBTPXR71B57JFBW9Z1','alice','thread'),null);
});
