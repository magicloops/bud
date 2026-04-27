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
    size: 10,
  });

  assert.equal(frame?.accepted, true);
  const open = await openPromise;
  assert.equal(open.status_code, 206);
  assert.deepEqual(open.content_identity, { size: 10, modified_ms: 1777132800000 });

  const chunks: Buffer[] = [];
  runtime.body.on("data", (chunk: Buffer) => chunks.push(chunk));
  await runtime.handleData(Buffer.from("hello"));
  const ended = once(runtime.body, "end");
  runtime.handleClose();
  await ended;

  assert.equal(Buffer.concat(chunks).toString("utf-8"), "hello");
  assert.equal(cleaned, true);
});
