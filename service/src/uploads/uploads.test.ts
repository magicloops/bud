import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ulid } from 'ulid';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { authUserTable, userFileTable } from '../db/schema.js';
import { FileRepository } from './repository.js';
import { LocalFileObjects, originalBytes } from './objects.js';
import { fileIntent } from './contracts.js';
import { parseDocument } from './documents.js';
import { registerUploadRoutes } from './routes.js';
import { agentFile, executeFileTool } from './agent.js';
import { browserFiles, registerBrowserFileTransfers } from './browser-files.js';
import { budTable, threadTable, messageTable } from '../db/schema.js';
import { runInNewContext } from 'node:vm';
import { selectedDocumentPages } from './page-references.js';
import { hydratedImageIds, IMAGE_TOKEN_ESTIMATE } from '../browser/image-references.js';
import { estimateCanonicalMessagesBreakdown } from '../agent/context-budget.js';
import type { CanonicalMessage } from '../llm/types.js';

function pdf(text = 'Alex Example - alex@example.test - TypeScript Engineer') {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(data);
}
test('originals remain immutable and hash checked; bounds, names, symlinks fail closed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'bud-upload-test-')), objects = new LocalFileObjects(path), id = `file_${ulid()}`;
  try {
    const bytes = pdf(); const result = await objects.receive(id,bytes.length,Readable.from([bytes.subarray(0,10),bytes.subarray(10)]));
    assert.deepEqual(await originalBytes(objects,id,bytes.length,result.sha256),bytes);
    await assert.rejects(objects.receive(id,bytes.length,Readable.from([bytes])), /EEXIST/);
    await assert.rejects(originalBytes(objects,id,bytes.length,'0'.repeat(64)), /integrity/);
    await assert.rejects(objects.receive(`file_${ulid()}`,2,Readable.from([bytes])), /size_mismatch/);
    await assert.rejects(objects.receive(`file_${ulid()}`,bytes.length+1,Readable.from([bytes])), /size_mismatch/);
    const link = `file_${ulid()}`; await symlink(join(path,id),join(path,link));
    await assert.rejects(objects.get(link));
    for (const name of ['../x','a/b','a\\b','.','..','bad\u0000name']) assert.equal(fileIntent.safeParse({name,mime_type:'text/plain',size_bytes:1}).success,false);
  } finally { await rm(path,{recursive:true,force:true}); }
});
test('PDF text, page rendering, empty extraction and binary-safe errors', async () => {
  const result = await parseDocument(pdf(), 'resume.pdf','application/pdf');
  assert.ok('pages' in result); assert.match(result.pages.join(''), /Alex Example/); assert.equal(result.complete,true);
  const image = await parseDocument(pdf(),'resume.pdf','application/pdf',1);
  assert.ok('image' in image); assert.equal(Buffer.from(image.image,'base64')[0],255);
  const blank = await parseDocument(pdf(''),'scan.pdf','application/pdf');
  assert.ok('pages' in blank); assert.equal(blank.complete,false); assert.ok(blank.warnings.length);
  await assert.rejects(parseDocument(Buffer.from('%PDF-garbage'),'broken.pdf','application/pdf'), /file_unreadable/);
  await assert.rejects(parseDocument(Buffer.from([0,255]),'binary.txt','text/plain'));
  const text = await parseDocument(Buffer.from('Resume — 中文'),'résumé.txt','text/plain');
  assert.ok('pages' in text); assert.equal(text.pages[0],'Resume — 中文');
});
test('owned HTTP uploads, downloads, deletion, retry and origin boundaries', {skip:process.env.BUD_UPLOAD_DB_TEST !== '1'}, async () => {
  if (!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? 'postgres://localhost/bud').hostname)) throw Error('local database only');
  const owners = ['upload-test-'+randomUUID(),'upload-test-'+randomUUID()];
  const directory = await mkdtemp(join(tmpdir(),'bud-http-upload-')), objects = new LocalFileObjects(directory), repository = new FileRepository();
  process.env.FILE_STORAGE_DIRECTORY = directory;
  const budId = `upload-test-${randomUUID()}`, threadId = randomUUID();
  const app = Fastify();
  try {
    await db.insert(authUserTable).values(owners.map(id=>({id,name:'Upload test',email:id+'@example.test',emailVerified:false,createdAt:new Date(),updatedAt:new Date()})));
    await db.insert(budTable).values({budId,name:'Upload test',os:'test',arch:'test',createdByUserId:owners[0]});
    await db.insert(threadTable).values({threadId,budId,createdByUserId:owners[0]});
    await registerUploadRoutes(app,{repository,objects:()=>objects,viewer:async(request,reply)=>{
      const userId = request.headers['test-owner'];
      if (typeof userId !== 'string' || !owners.includes(userId)) { reply.code(401).send({error:'unauthorized'}); return null; }
      return {userId,authType:request.headers['test-cookie'] ? 'cookie':'bearer',sessionId:null,email:null};
    }});
    await registerBrowserFileTransfers(app);
    const bytes = pdf(), headers={'test-owner':owners[0]};
    assert.equal((await app.inject({method:'POST',url:'/api/uploads',payload:{name:'x',size_bytes:1}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/uploads',headers:{...headers,'test-cookie':'yes'},payload:{name:'x',size_bytes:1}})).statusCode,403);
    const reserve=await app.inject({method:'POST',url:'/api/uploads',headers,payload:{name:'résumé.pdf',mime_type:'application/pdf',size_bytes:bytes.length}});
    assert.equal(reserve.statusCode,201,reserve.body); const {file_id:id}=reserve.json();
    const path=`/api/uploads/${id}/content`;
    assert.equal((await app.inject({method:'PUT',url:path,headers:{'test-owner':owners[1],'content-type':'application/octet-stream'},payload:bytes})).statusCode,404);
    const uploaded=await app.inject({method:'PUT',url:path,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});
    assert.equal(uploaded.statusCode,200,uploaded.body);
    assert.equal((await app.inject({method:'PUT',url:path,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes})).statusCode,409);
    assert.equal((await app.inject({method:'GET',url:path,headers:{'test-owner':owners[1]}})).statusCode,404);
    const downloaded=await app.inject({method:'GET',url:path,headers});
    assert.deepEqual(downloaded.rawPayload,bytes); assert.match(String(downloaded.headers['content-disposition']),/r%C3%A9sum%C3%A9.pdf/);
    await assert.rejects(repository.attachments(owners[1],[id]),/file_not_found/);
    assert.equal((await repository.attachments(owners[0],[id]))[0].file_id,id);
    const context={ownerUserId:owners[0],budId,threadId,turnId:'test',signal:new AbortController().signal};
    await assert.rejects(agentFile(context,id),/file_not_found/);
    await db.insert(messageTable).values({clientId:randomUUID(),threadId,role:'user',content:'Read this resume',createdByUserId:owners[0],metadata:{attachments:[{file_id:id}]}});
    const read = await executeFileTool(context,{type:'tool_call',tool:'files_read',callId:'read',args:{file_id:id}});
    assert.equal(read.result.ok,true); assert.match(String(read.payload.text),/Alex Example/);
    await assert.rejects(agentFile({...context,ownerUserId:owners[1]},id),/file_not_found/);
    await assert.rejects(agentFile({...context,invocation:{id:'missing',fence:1,workerId:'other'}},id),/file_authority_expired/);
    // Transfer grants are single-use, revocable and carry the unchanged original.
    const transfer = await browserFiles(context,[id],async()=>true);
    const grant = await runInNewContext(transfer.prefix + `uploads.attach('target','ref','obs',${JSON.stringify(id)})`,{repl:{attachFile:(value:unknown)=>value}});
    const transferred=await app.inject({url:'/api/uploads/browser-transfer',headers:{authorization:`Bearer ${grant.ticket}`}});
    assert.equal(transferred.statusCode,200,transferred.body); assert.deepEqual(transferred.rawPayload,bytes);
    assert.equal((await app.inject({url:'/api/uploads/browser-transfer',headers:{authorization:`Bearer ${grant.ticket}`}})).statusCode,403);
    transfer.dispose();
    for (const authorized of [true,false]) {
      const revoked=await browserFiles(context,[id],async()=>authorized);
      const ticket=await runInNewContext(revoked.prefix + `uploads.attach('target','ref','obs',${JSON.stringify(id)})`,{repl:{attachFile:(value:{ticket:string})=>value.ticket}});
      if (authorized) revoked.dispose();
      assert.equal((await app.inject({url:'/api/uploads/browser-transfer',headers:{authorization:`Bearer ${ticket}`}})).statusCode,403);
      revoked.dispose();
    }
    assert.equal((await app.inject({method:'DELETE',url:`/api/uploads/${id}`,headers})).statusCode,204);
    assert.equal((await app.inject({method:'GET',url:path,headers})).statusCode,404);
    await assert.rejects(repository.attachments(owners[0],[id]),/file_not_found/);
    await assert.rejects(agentFile(context,id),/file_not_found/);
    // Database rejects ready records without verified originals.
    await assert.rejects(db.insert(userFileTable).values({id:`file_${ulid()}`,createdByUserId:owners[0],name:'x',mimeType:'text/plain',sizeBytes:1,state:'ready'}));
  } finally {
    await db.delete(budTable).where(eq(budTable.budId,budId));
    await app.close(); await db.delete(userFileTable).where(inArray(userFileTable.createdByUserId,owners));
    await db.delete(authUserTable).where(inArray(authUserTable.id,owners)); await rm(directory,{recursive:true,force:true});
    await pool.end();
  }
});

test('document vision window is shared by hydration, token estimates and measured anchors', () => {
  const file_id=`file_${ulid()}`;
  const messages: CanonicalMessage[] = [1,2,3].map(page=>({role:'user',content:[{type:'tool_result',tool_use_id:`read-${page}`,content:JSON.stringify({tool:'files_read',ok:true,document_page:{file_id,page}})}]}));
  assert.deepEqual([...selectedDocumentPages(messages).values()].map(value=>value.page),[2,3]);
  assert.equal(estimateCanonicalMessagesBreakdown(messages).images,2*IMAGE_TOKEN_ESTIMATE);
  assert.deepEqual(hydratedImageIds(messages),[`document:${file_id}:2`,`document:${file_id}:3`]);
  assert.deepEqual(hydratedImageIds(messages,1),[]);
});

test('DOCX extraction reads document text without shell or office dependencies', async () => {
  const bytes = Buffer.from('UEsDBBQAAAAIACwWT133S4B1wgAAAHYBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QuQ7CMAyGX6XKiqgRAwOiLMAKDLyAlbptRC7FLsfbk3INCBjt//gsLw7XSFxcnPVcqU4kzgFYd+SQyxDJZ6UJyaHkMbUQUR+xJZhOJjPQwQt5GcvQoZaLNTXYWyk2l7xmE3ylEllWxephHFiVwhit0ShZh5OvPyjjJ6HMybuHOxN5lA0KvhIG5TfgmdudKCVTU7HHJFt02QXnkGqog+5dTpb/a77cGZrGaHrnh7aYgiZm41tny7fi0PjX/XB/9/IGUEsDBBQAAAAIACwWT11hey9DiQAAAPIAAAALAAAAX3JlbHMvLnJlbHONzzsOAiEQBuCrEA6ws1pYGKCy2dZ4AQLDIy6PDBj19lJYrMbCcuaffH9GnHHVPZbcQqyNPdKam+Sh93oEaCZg0m0qFfNIXKGk+xjJQ9Xmqj3Cfp4PQFuDK7E12WIlp8XuOLs8K/5jF+eiwVMxt4S5/6j4uhiyJo9d8nshC/a9ngbLQQn4eFG9AFBLAwQUAAAACAAsFk9d4k+SKJAAAAC2AAAAEQAAAHdvcmQvZG9jdW1lbnQueG1sRc7BDcIwDAXQVaIOgCsOHKJSiQMTwAIhNW2kxLGcVGlvDMGETEJTDlzel2Xry13RQ7RzQMpqCZ6SLudmypk1QLITBpMOkZG23TNKMHkbZYQSZWCJFlNyNAYPx7Y9QTCOmr4r+hGHtSZXpJL7i8dFXRcT2KP6vN7qvjLerDjOCml0hCgd1Muq7PLurw3+n/ZfUEsBAhQDFAAAAAgALBZPXfdLgHXCAAAAdgEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAsFk9dYXsvQ4kAAADyAAAACwAAAAAAAAAAAAAAgAHzAAAAX3JlbHMvLnJlbHNQSwECFAMUAAAACAAsFk9d4k+SKJAAAAC2AAAAEQAAAAAAAAAAAAAAgAGlAQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAAZAIAAAAA', 'base64');
  const document = await parseDocument(bytes, 'resume.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok('pages' in document); assert.match(document.pages.join(''), /Alex Example — TypeScript engineer/);
});
