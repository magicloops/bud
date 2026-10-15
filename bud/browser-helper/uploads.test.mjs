import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Engine } from './engine.mjs';

test('hidden and iframe uploads select exact original bytes without submitting or retargeting', { skip: !process.env.BUD_BROWSER_EXECUTABLE }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.BUD_BROWSER_EXECUTABLE, headless: true, args: ['--use-mock-keychain','--password-store=basic'] });
  const directory = await mkdtemp(join(tmpdir(),'bud-file-fixture-'));
  try {
    const bytes = Buffer.from('Synthetic resume — original bytes'), path = join(directory,'résumé.pdf'); await writeFile(path,bytes);
    const page = await browser.newPage();
    await page.setContent('<form onsubmit="window.submitted=true;return false"><input name="Resume" type="file" hidden><input name="Folder" type="file" webkitdirectory><button>Submit</button></form><iframe srcdoc="<label>Resume<input type=file name=Other></label>"></iframe>');
    const child = page.frames().find(f=>f.parentFrame()); await child.locator('input').waitFor();
    const cdp = await page.context().newCDPSession(page), target_id=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    const engine = new Engine(browser), observe=()=>engine.execute({operation:'file_inputs',target_id});
    let observation=await observe(); assert.equal(observation.inputs.length,3);
    const upload=(input, paths=[path])=>engine.execute({operation:'set_files',target_id,observation_id:observation.observation_id,reference:input.reference,paths});
    const result=await upload(observation.inputs[0]); assert.deepEqual(result.selected,[{name:'résumé.pdf',size_bytes:bytes.length}]);
    assert.deepEqual(await page.locator('input[name=Resume]').evaluate(async el=>Array.from(new Uint8Array(await el.files[0].arrayBuffer()))),[...bytes]);
    assert.equal(await page.evaluate(()=>window.submitted),undefined);
    await assert.rejects(upload(observation.inputs[1]),/file_input_unsupported/);
    await upload(observation.inputs[2]); assert.equal(await child.locator('input').evaluate(el=>el.files[0].name),'résumé.pdf');
    await assert.rejects(upload(observation.inputs[0],[path,path]),/not_multiple/);
    const link=join(directory,'link.pdf'); await symlink(path,link); await assert.rejects(upload(observation.inputs[0],[link]));
    await page.locator('input[name=Resume]').evaluate(el=>el.outerHTML='<input type=file name=Resume>');
    await assert.rejects(upload(observation.inputs[0]),/stale_reference/);
    observation=await observe(); const stale=observation; await observe();
    await assert.rejects(upload(stale.inputs[0]),/stale_reference/);
    observation=await observe(); await page.goto('about:blank'); await assert.rejects(upload(observation.inputs[0]),/stale_reference/);
  } finally { await browser.close(); await rm(directory,{recursive:true,force:true}); }
});
