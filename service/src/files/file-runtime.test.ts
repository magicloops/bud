import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { FileRuntimeStream, handleFileOpenResult, registerFileRuntimeStream } from "./file-runtime.js";

test("file runtime receives open results and streams chunks", async () => {
  let cleaned = false;
  const runtime = new FileRuntimeStream("st_test", "op_test", () => {
    cleaned = true;
  });
  registerFileRuntimeStream(runtime);

  const openPromise = runtime.waitForOpen(1000);
  const frame = handleFileOpenResult({
    proto: "0.1",
    type: "file_open_result",
    id: "msg_file_open_result",
    ts: Date.now(),
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    accepted: true,
    status_code: 206,
    headers: { "content-range": "bytes 0-4/10" },
    content_identity: { size: 10, modified_ms: 1777132800000 },
    resolved_against: "terminal_cwd",
    resolved_relative_path: "service/src/file.ts",
    size: 10,
  });

  assert.equal(frame?.accepted, true);
  const open = await openPromise;
  assert.equal(open.status_code, 206);
  assert.deepEqual(open.content_identity, { size: 10, modified_ms: 1777132800000 });
  assert.equal(open.resolved_against, "terminal_cwd");
  assert.equal(open.resolved_relative_path, "service/src/file.ts");

  const chunks: Buffer[] = [];
  runtime.body.on("data", (chunk: Buffer) => chunks.push(chunk));
  await runtime.handleData(Buffer.from("hello"));
  const ended = once(runtime.body, "end");
  runtime.handleClose();
  await ended;

  assert.equal(Buffer.concat(chunks).toString("utf-8"), "hello");
  assert.equal(cleaned, true);
});

test("file runtime tolerates stream close before open result", async () => {
  let cleaned = false;
  const runtime = new FileRuntimeStream("st_close_first", "op_close_first", () => {
    cleaned = true;
  });
  registerFileRuntimeStream(runtime);

  const openPromise = runtime.waitForOpen(1000);
  const ended = once(runtime.body, "end");
  runtime.body.resume();
  runtime.handleClose();

  assert.equal(cleaned, false);

  const frame = handleFileOpenResult({
    proto: "0.1",
    type: "file_open_result",
    id: "msg_file_open_result",
    ts: Date.now(),
    ext: {},
    operation_id: "op_close_first",
    stream_id: "st_close_first",
    accepted: true,
    status_code: 200,
    headers: { "content-length": "0" },
    content_identity: { size: 0, modified_ms: 1777132800000 },
    size: 0,
  });

  assert.equal(frame?.accepted, true);
  const open = await openPromise;
  assert.equal(open.status_code, 200);
  await ended;
  assert.equal(cleaned, true);
});

test("file runtime enforces max received bytes", async () => {
  let cleaned = false;
  const runtime = new FileRuntimeStream(
    "st_over_limit",
    "op_over_limit",
    () => {
      cleaned = true;
    },
    { maxReceivedBytes: 4 },
  );

  await assert.rejects(
    runtime.handleData(Buffer.from("hello")),
    /file response exceeded max bytes 4/,
  );
  assert.equal(cleaned, true);
  assert.equal(runtime.isComplete(), true);
});
