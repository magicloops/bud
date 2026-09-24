/** Opt-in fixed-fixture comparison. Real provider + Chrome + helper/worker;
 * no service DB, daemon authority, user profile or viewer involved. */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenAIProvider } from '../src/llm/providers/openai.js';
import { BROWSER_REPL_TOOLS, parseBrowserInput } from '../src/agent/browser-tools.js';
import type { CanonicalMessage, CanonicalTool, ModelConfig } from '../src/llm/types.js';

const helper = resolve('../bud/browser-helper');
const { chromium } = await import(pathToFileURL(join(helper, 'node_modules/playwright-core/index.mjs')).href);
const { Engine } = await import(pathToFileURL(join(helper, 'engine.mjs')).href);
const model = process.env.BUD_BROWSER_LIVE_MODEL ?? process.env.DEFAULT_MODEL;
const repeats = Number(process.env.BUD_BROWSER_COMPARISON_REPEATS ?? 3);
const output = process.argv[2];
if (!model || !output || !process.env.OPENAI_API_KEY || !process.env.BUD_BROWSER_NODE || !process.env.BUD_BROWSER_EXECUTABLE)
  throw Error('Require output path, OPENAI_API_KEY, model (BUD_BROWSER_LIVE_MODEL or DEFAULT_MODEL), BUD_BROWSER_NODE and BUD_BROWSER_EXECUTABLE');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw Error('repeats must be 1..5');
const effort = process.env.BUD_BROWSER_COMPARISON_EFFORT ?? 'low';
if (effort !== 'low' && effort !== 'high') throw Error('effort must be low or high');
const config: ModelConfig = { model, maxOutputTokens: 3000, reasoning: {enabled:true,effort} };
const provider = new OpenAIProvider(process.env.OPENAI_API_KEY, {timeout:60000});
// Optional frozen catalog compares REPL guidance on the SAME runtime.
const baselinePath = process.argv[3];
const baseline: CanonicalTool[] | undefined = baselinePath
  ? JSON.parse(await readFile(baselinePath, 'utf8')) : undefined;
if (baseline && (!Array.isArray(baseline) || !baseline.some(t => t.name === 'browser_exec') ||
    baseline.some(t => !['browser_exec', 'browser_request_handoff'].includes(t.name))))
  throw Error('Baseline must be a saved REPL catalog');
const catalogs: Record<string, CanonicalTool[]> = baseline ? {baseline, candidate:BROWSER_REPL_TOOLS}
  : {tools:repl:BROWSER_REPL_TOOLS};
// Phase 7b can freeze the baseline worker as well as its catalog. Budget
// variants use identical candidate code; a cell prefix selects the existing API.
const baselineHelper = process.env.BUD_BROWSER_COMPARISON_BASELINE_HELPER;
if (baselineHelper && !baseline) throw Error('Baseline helper requires a baseline catalog');
const budgets = process.env.BUD_BROWSER_COMPARISON_BUDGETS?.split(',').map(Number);
if (budgets) {
  if (!baseline || budgets.some(b => ![8192,16384,32768].includes(b)) || !budgets.length)
    throw Error('Budget comparison requires baseline and budgets 8192,16384,32768');
  delete catalogs.candidate;
  for (const budget of budgets) catalogs[`candidate_${budget}`] = BROWSER_REPL_TOOLS.map(t => ({...t,
    description:t.description.replace('share 8 KiB UTF-8 per cell', `share ${budget/1024} KiB UTF-8 per cell`)}));
}
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Fixture = {name:string; html:string; task:string; expected:unknown;
  followup?: {task:string; expected:unknown}; seed?:string; verify?: (page:any)=>Promise<boolean>};
const fixtures: Fixture[] = [
  {name:'table',html:`<title>Inventory</title><table><tr><th>Item</th><th>Stock</th><th>Destination</th></tr>${Array.from({length:120},(_,i)=>`<tr><td>Item ${i}</td><td>${i*3+7}</td><td><a href="https://example.test/item/${i}?variant=blue#details">Details ${i}</a></td></tr>`).join('')}</table>`,
    task:'Read inventory for Item 73 and Item 91. Return only JSON {"items":[{"name":...,"stock":a number,"url":...}]} in that order. Preserve the complete destination URL.',
    expected:{items:[73,91].map(i=>({name:`Item ${i}`,stock:i*3+7,url:`https://example.test/item/${i}?variant=blue#details`}))}},
  {name:'article',html:`<title>Operating manual</title><main>${Array.from({length:45},(_,i)=>`<section><h2>Procedure ${i}</h2><p>For procedure ${i}, keep the valve at ${i+12} degrees for ${i+4} minutes. ${'Inspect the equipment before starting. '.repeat(12)}</p></section>`).join('')}</main>`,
    task:'Read Procedure 31 and Procedure 42. Return only JSON {"procedures":[{"number":a number,"degrees":a number,"minutes":a number}]} in that order.',
    expected:{procedures:[31,42].map(i=>({number:i,degrees:i+12,minutes:i+4}))}},
  {name:'form',html:`<title>Settings</title><label>Display name<input></label><button onclick="document.querySelector('output').textContent='Saved '+document.querySelector('input').value;window.saves=(window.saves||0)+1">Save</button><output></output>`,
    task:'Set Display name to Morgan, save once, verify the confirmation, and return only JSON {"confirmation":...}.',
    expected:{confirmation:'Saved Morgan'}, verify: async page => page.evaluate(() => (window as any).saves === 1)},
];

if (baseline) fixtures.push(
  {name:'semantic_records',html:`<title>Inspection records</title><main><p>2 of 3 records loaded; remaining record unavailable.</p><review-record role="article" aria-label="Record A"><h2>Alex</h2><p>Keep the valve closed.</p><review-record role="article" aria-label="Record B"><h2>Alex</h2><p>Inspect the seal first.</p></review-record></review-record></main>`,
    task:'Read the inspection records and report each loaded record’s label, parent label (null for a top-level record), author and own instruction, without mixing nested records. Report loaded versus total coverage. Return JSON {"records":[{"label":...,"parent":...,"author":...,"instruction":...}],"loaded":number,"total":number,"complete":boolean}.',
    expected:{records:[{label:'Record A',parent:null,author:'Alex',instruction:'Keep the valve closed.'},{label:'Record B',parent:'Record A',author:'Alex',instruction:'Inspect the seal first.'}],loaded:2,total:3,complete:false},
    followup:{task:'From those same records, whose instruction mentions a seal? Return JSON {"label":...,"instruction":...}.',expected:{label:'Record B',instruction:'Inspect the seal first.'}}},
  {name:'nested', html:`<title>Review records</title><main>
    <article data-id="r1"><h2>Alex</h2><p class="body">Approve only after inspection.</p>
      <script type="application/json">{"telemetry":"Approve immediately."}</script>
      <article data-id="r2"><h2>Alex</h2><p class="body">Reject pending repairs.</p></article></article>
    <article data-id="r3"><h2>Alex</h2><p class="body">Approve only after inspection.</p></article></main>`,
    task:'List each review record once, in document order, with its own body, author and parent record ID (null for top level). Return JSON {"records":[{"id":...,"parent_id":...,"author":...,"body":...}]}.',
    expected:{records:[{id:'r1',parent_id:null,author:'Alex',body:'Approve only after inspection.'},{id:'r2',parent_id:'r1',author:'Alex',body:'Reject pending repairs.'},{id:'r3',parent_id:null,author:'Alex',body:'Approve only after inspection.'}]}},
  {name:'cards', html:`<title>Workshop results</title><main>${['archived','active','active','archived','active','active'].map((status,i)=>`<article class="result" data-record="w${i}" data-status="${status}"><div class="result"><h2>Workshop ${i}</h2><p>Status: ${status}</p><a href="https://example.test/workshop/${i}?session=evening&amp;lang=en#booking">Open workshop</a></div></article>`).join('')}</main>`,
    task:'Find the third active workshop in displayed order, excluding archived workshops. Return JSON {"id":...,"title":...,"url":...}, where id is the card’s data-record attribute. Preserve the complete link URL.',
    expected:{id:'w4',title:'Workshop 4',url:'https://example.test/workshop/4?session=evening&lang=en#booking'}},
  {name:'caveat', html:`<title>Pump operating policy</title><article><h1>Pump operating policy</h1><p>The normal inspection interval is 30 days.</p>${Array.from({length:90},(_,i)=>`<p>Maintenance note ${i}: ${'Record measured pressure and verify the enclosure before each shift. '.repeat(4)}</p>`).join('')}<p>Exception: units installed offshore require inspection every 7 days.</p><p>Revision code: KESTREL-42. Emergency coordinator: Mira Chen.</p></article>`,
    task:'Read the pump policy and report the normal and offshore inspection intervals. Return JSON {"normal_days":number,"offshore_days":number}.',
    expected:{normal_days:30,offshore_days:7},
    followup:{task:'From that policy, what are the revision code and emergency coordinator? Return JSON {"revision":...,"coordinator":...}.',expected:{revision:'KESTREL-42',coordinator:'Mira Chen'}}},
  {name:'partial',html:`<title>Measurements</title><p id="coverage">2 of 5 measurements loaded</p><ul><li data-id="m1">Reading: 13</li><li data-id="m2">Reading: 29</li></ul><button onclick="document.querySelector('ul').insertAdjacentHTML('beforeend','<li data-id=m3>Reading: 7</li><li data-id=m4>Reading: 41</li><li data-id=m5>Reading: 18</li>');document.querySelector('#coverage').textContent='5 of 5 measurements loaded';this.remove();window.loads=(window.loads||0)+1">Load more</button>`,
    task:'Find the maximum reading across all five measurements. Load remaining measurements if possible. Return JSON {"max":number,"loaded":number,"total":number,"complete":boolean}.',
    expected:{max:41,loaded:5,total:5,complete:true},verify:async page=>page.evaluate(()=>(window as any).loads===1)},
  {name:'overflow',html:`<title>Export complete</title><p>An export has been recorded.</p><script id="export-data" type="application/json">${JSON.stringify(Array.from({length:160},(_,i)=>({id:'r'+i,flagged:i===37||i===143,checksum:i===37?'amber-19':i===143?'teal-83':'ordinary',body:'Export detail '.repeat(35)})))}</script>`,
    task:'Recover the export result from the preceding completed cell: report the IDs and checksums of the flagged rows, in order. Return JSON {"rows":[{"id":...,"checksum":...}]}. Do not repeat the export.',
    seed:`var tab = await browser.tabs.current(); var records = await tab.evaluate(() => { window.exports=(window.exports||0)+1; return JSON.parse(document.querySelector('#export-data').textContent); }); console.log(JSON.stringify(records));`,
    expected:{rows:[{id:'r37',checksum:'amber-19'},{id:'r143',checksum:'teal-83'}]},verify:async page=>page.evaluate(()=>(window as any).exports===1)},
);

// Interaction regressions are opt-in so existing comparison sets stay comparable.
if (process.env.BUD_BROWSER_COMPARISON_FIXTURES?.split(',').some(name => ['disclosure','layered'].includes(name))) fixtures.push(
  {name:'disclosure',html:`<title>Inspection record</title><details role="article"><summary style="cursor:pointer;height:50px">Inspection record <a href="#profile" onclick="window.profileClicks=(window.profileClicks||0)+1;event.preventDefault()">Technician</a></summary><p>Inspection code: HERON-27</p></details>`,
    task:'Expand the inspection record using its disclosure control, read the inspection code, and return JSON {"code":...}. Do not open the technician profile. Use the element click API for interaction.',
    expected:{code:'HERON-27'},verify:async page=>page.evaluate(()=>document.querySelector('details')!.open && !(window as any).profileClicks)},
  {name:'layered',html:`<title>Report card</title><style>body{margin:0}article{position:relative;height:490px}#card{position:absolute;inset:0;z-index:2}#title{position:absolute;top:36px;left:16px;right:16px;height:20px}img{position:absolute;top:90px;left:16px;width:calc(100% - 32px);height:300px;z-index:3}</style><article><a id="card" href="#report" aria-label="Open report" onclick="window.posts=(window.posts||0)+1;document.querySelector('output').textContent='Report opened: IBIS-16'"></a><a id="title" href="#report">Inspection report</a><img alt="Report preview" onclick="window.previews=(window.previews||0)+1"></article><output></output>`,
    task:'Open the report through its card link, verify the resulting confirmation, and return JSON {"confirmation":...}. Do not open the preview image. Use the element click API for interaction; inspect the layout if necessary.',
    expected:{confirmation:'Report opened: IBIS-16'},verify:async page=>page.evaluate(()=>(window as any).posts===1 && !(window as any).previews)},
);

if (baseline) fixtures.push({name:'repeated_urls',
  html:`<title>Dispatch records</title><main>${Array.from({length:24},(_,i)=>`<section><h2>Record ${i}</h2><a href="https://example.test/open?token=${'exact%2F'.repeat(180)}&amp;record=${i===17?'special':'common'}#details">Open record</a><p>Code: ${i===17?'KESTREL-91':'ordinary'}</p></section>`).join('')}</main>`,
  task:'Find the record with code KESTREL-91 and open its linked destination using the complete observed URL. Preserve its query and fragment without reconstructing the token. Return JSON {"record":number}.',
  expected:{record:17},verify:async page=>page.url()===`https://example.test/open?token=${'exact%2F'.repeat(180)}&record=special#details`});

const fixtureFilter = process.env.BUD_BROWSER_COMPARISON_FIXTURES?.split(',');
if (fixtureFilter?.some(name => !fixtures.some(f => f.name === name))) throw Error('Unknown fixture filter');
const selectedFixtures = fixtures.filter(f => !fixtureFilter || fixtureFilter.includes(f.name));
const versions = Object.fromEntries(await Promise.all(['repl-worker.mjs','repl-api.mjs','repl-artifacts.mjs','repl-snapshot.mjs','engine.mjs','compact.mjs'].map(async name =>
  [name,createHash('sha256').update(await readFile(join(helper,name))).digest('hex')])));
const baselineVersions = baselineHelper ? Object.fromEntries(await Promise.all(['repl-worker.mjs','repl-api.mjs','repl-artifacts.mjs'].map(async name => [name,createHash('sha256').update(await readFile(join(baselineHelper,name))).digest('hex')]))):undefined;
const report: any = {baselineVersions,budgets,config,repeats,fixtures:selectedFixtures,versions,catalogs,catalog_hashes:Object.fromEntries(Object.entries(catalogs).map(([name,tools])=>[name,hash(tools)])),fixture_hash:hash(selectedFixtures),harness_hash:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),scope:'Disposable headless Chrome and real semantic helper/REPL worker; excludes daemon, service persistence, private handoff, viewer and network latency.',runs:[]};
const save = () => writeFile(output, JSON.stringify(report,null,2), {mode:0o600});

for (const fixture of selectedFixtures) for (let repeat=0;repeat<repeats;repeat++) {
  // Alternate order to reduce warm-cache/order bias; cache counts remain explicit.
  for (const mode of repeat%2 ? Object.keys(catalogs).reverse() : Object.keys(catalogs)) {
    const started=Date.now();
    const chrome=await chromium.launch({executablePath:process.env.BUD_BROWSER_EXECUTABLE,headless:true,args:['--use-mock-keychain','--password-store=basic']});
    const directory=await mkdtemp(join(tmpdir(),'bud-browser-comparison-'));
    const workerHelper=mode==='baseline' && baselineHelper ? baselineHelper : helper;
    const budget=mode.startsWith('candidate_') ? Number(mode.slice('candidate_'.length)) : 8192;
    const child=spawn(process.env.BUD_BROWSER_NODE!,[join(workerHelper,'repl-worker.mjs'),directory],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','ignore']});
    const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    const run:any={fixture:fixture.name,repeat,mode,budget,steps:[],correct:false,tool_calls:0,tool_output_bytes:0,input_tokens:0,output_tokens:0,cached_input_tokens:0,peak_input_tokens:0,tool_ms:0,operations:[],answers:[],seeded_overflows:0,natural_overflows:0,budget_request_cells:0};
    try {
      const page=await chrome.newPage();
      const fixtureUrl=`https://fixture.test/${fixture.name}`;
      // All pages are local fixtures, including deliberate link navigation.
      // No generated action can send a browser request to a real site.
      await page.context().route('**/*', async (route:any)=>{
        const url=new URL(route.request().url());
        const item=url.hostname==='example.test' && url.pathname.match(/^\/item\/(\d+)$/);
        const html=url.href===fixtureUrl ? fixture.html : item
          ? `<title>Item ${Number(item[1])}</title><h1>Item ${Number(item[1])}</h1><p>Stock: ${Number(item[1])*3+7}</p><a href="${fixtureUrl}">Inventory</a>`
          : '<title>Outside fixture</title><p>This destination has no fixture content.</p>';
        await route.fulfill({contentType:'text/html',body:html});
      });
      await page.goto(fixtureUrl);
      const cdp=await page.context().newCDPSession(page);
      const target=(await cdp.send('Target.getTargetInfo')).targetInfo.targetId;await cdp.detach();
      const engine=new Engine(chrome);
      const tabs=async()=>[{target_id:target,title:await page.title(),url:page.url(),selected:true}];
      const bridge=async(c:any):Promise<any>=>{
        run.operations.push({action:c.action,operation:c.operation,at:Date.now()-started});
        if(c.target_id && c.target_id!==target)throw Error('browser_target_not_found');
        if(c.action==='open' || c.action==='navigate'){if(c.url)await page.goto(c.url);return {target_id:target,targets:await tabs()};}
        if(c.action==='repl' && c.operation==='tabs')return tabs();
        if(c.action==='repl' || c.action==='inspect'){
          try {
            const data=await engine.execute({...c,target_id:target,full:c.action==='repl',compact:c.action==='repl'});
            return c.action==='inspect'?{observation:data}:data;
          } catch (error) {
            // Match main.mjs: the product does not expose raw Playwright call logs.
            const message=error instanceof Error?error.message:'';
            throw Error(/^browser_[a-z_]+$/.test(message)?message:'browser_outcome_unknown');
          }
        }
        throw Error('fixture_operation_unsupported');
      };
      let serial=0;
      const cell=async(code:string)=>{
        const cell_id=String(++serial);send({type:'execute',cell_id,code:budget===8192?code:`repl.setOutputBudget(${budget});\n${code}`});
        while(true){
          const next=await lines.next();if(next.done)throw Error('worker_exited');
          const message=JSON.parse(next.value);
          if(message.type==='result')return message;
          try {send({type:'operation_result',cell_id,operation_id:message.operation_id,ok:true,data:await bridge(message.command)});}
          catch(e){send({type:'operation_result',cell_id,operation_id:message.operation_id,ok:false,error:e instanceof Error?e.message:'fixture_error'});}
        }
      };
      const tools=catalogs[mode as keyof typeof catalogs]!.filter(t=>t.name!=='browser_request_handoff');
      const messages:CanonicalMessage[]=[{role:'system',content:'Use only the supplied browser tools. The owned page is already open. Complete the task using page evidence; do not guess values or infer patterns. Final response must be the requested JSON without fences.'},{role:'user',content:fixture.task}];
      if(fixture.seed){
        messages.push({role:'assistant',content:[{type:'tool_use',id:'seed',name:'browser_exec',input:{code:fixture.seed}}]});
        const result=await cell(fixture.seed);
        if(!result.ok || !result.truncated || result.output_artifact?.truncated) throw Error('invalid_overflow_seed');
        run.seeded_overflows=1;run.seed={code:fixture.seed,result};
        messages.push({role:'user',content:[{type:'tool_result',tool_use_id:'seed',content:JSON.stringify(result)}]});
      }
      let followup=false, completed=false;
      for(let step=0;step<16;step++){
        const response=await provider.invokeSync(messages,tools,config,AbortSignal.timeout(60000));
        if(!response.usage)throw Error('missing_provider_usage');
        run.first_input_tokens??=response.usage.input_tokens;
        run.input_tokens+=response.usage.input_tokens;run.output_tokens+=response.usage.output_tokens;
        run.cached_input_tokens+=response.usage.cached_input_tokens??0;
        run.peak_input_tokens=Math.max(run.peak_input_tokens,response.usage.input_tokens);
        messages.push({role:'assistant',content:response.content});
        run.steps.push({usage:response.usage,content:response.content});
        if(!response.toolCalls?.length){
          const text=response.content.filter(b=>b.type==='text').map(b=>(b as {text:string}).text).join('');
          let correct=false;
          try {correct=isDeepStrictEqual(JSON.parse(text),followup?fixture.followup!.expected:fixture.expected);}catch{/* invalid answer */}
          run.answers.push({text,correct,followup});
          if(fixture.followup && !followup){
            run.followup_operation_start=run.operations.length;
            followup=true;messages.push({role:'user',content:fixture.followup.task});continue;
          }
          run.correct=run.answers.every((a:any)=>a.correct);
          if(fixture.verify){run.action_check=await fixture.verify(page);run.correct &&= run.action_check;}
          completed=true;break;
        }
        for(const call of response.toolCalls){
          run.tool_calls++;
          const toolStarted=Date.now();
          if(/\brepl\.setOutputBudget\s*\(/.test(String((call.input as any)?.code)))run.budget_request_cells++;
          let result;
          try{
            const args=parseBrowserInput(call.name as any,call.input);
            if(call.name==='browser_exec') {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {result=await Promise.race([cell(args.code as string),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cell_timeout')),30000);})]);}
              finally {clearTimeout(timer);}
            }
            else throw Error('fixture_operation_unsupported');
          }catch(e){if(e instanceof Error && e.message==='cell_timeout')throw e;result={error:e instanceof Error?e.message:'fixture_error'};}
          run.tool_ms+=Date.now()-toolStarted;
          if((result as any)?.truncated)run.natural_overflows++;
          const text=JSON.stringify(result);run.tool_output_bytes+=Buffer.byteLength(text);
          run.steps.push({call,result});messages.push({role:'user',content:[{type:'tool_result',tool_use_id:call.id,content:text}]});
        }
      }
      run.call_limit_exhausted=!completed;
      run.context_growth=run.peak_input_tokens-run.first_input_tokens;
      run.followup_browser_operations=fixture.followup?run.operations.length-run.followup_operation_start:undefined;
    }catch(e){run.error=e instanceof Error?e.message:'comparison_failed';}
    finally{if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}await chrome.close();await rm(directory,{recursive:true,force:true});}
    run.tool_failures=run.steps.filter((s:any)=>s.result && (s.result.error || s.result.ok===false)).length;
    run.duration_ms=Date.now()-started;run.provider_calls=run.steps.filter((s:any)=>s.usage).length;
    report.runs.push(run);await save();
    console.log(JSON.stringify({...run,steps:undefined}));
    if(run.error)throw Error('Comparison stopped; inspect report');
  }
}
if (report.runs.some((run:any)=>!run.correct)) process.exitCode=1;
