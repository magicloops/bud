import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  ProxyRuntimeStream,
  deleteProxyRuntimeStream,
  handleProxyOpenResult,
  registerProxyRuntimeStream,
} from "./proxy-runtime.js";

test("proxy runtime resolves open results and streams data to the response body", async () => {
  const chunks: Buffer[] = [];
  const runtime = new ProxyRuntimeStream("st_test", "op_test", () => {
    deleteProxyRuntimeStream("st_test");
  });
  registerProxyRuntimeStream(runtime);
  runtime.body.on("data", (chunk: Buffer) => chunks.push(chunk));

  const wait = runtime.waitForOpen(1000);
  const parsed = handleProxyOpenResult({
    proto: "0.1",
    type: "proxy_open_result",
    id: "msg_open_result",
    ts: 1777132800000,
    ext: {},
    operation_id: "op_test",
    stream_id: "st_test",
    accepted: true,
    status_code: 200,
    headers: { "content-type": "text/plain" },
    set_cookies: ["app_session=abc; Path=/"],
  });

  assert.equal(parsed?.accepted, true);
  const openResult = await wait;
  assert.equal(openResult.status_code, 200);
  assert.deepEqual(openResult.set_cookies, ["app_session=abc; Path=/"]);

  await runtime.handleData(Buffer.from("hello"));
  runtime.handleClose();

  assert.equal(Buffer.concat(chunks).toString("utf-8"), "hello");
  assert.equal(runtime.isComplete(), true);
  assert.equal(handleProxyOpenResult({}), null);
});

test("proxy runtime enforces max received bytes", async () => {
  let cleaned = false;
  const runtime = new ProxyRuntimeStream(
    "st_over_limit",
    "op_over_limit",
    () => {
      cleaned = true;
    },
    { maxReceivedBytes: 4 },
  );

  await assert.rejects(
    runtime.handleData(Buffer.from("hello")),
    /proxy response exceeded max bytes 4/,
  );
  assert.equal(cleaned, true);
  assert.equal(runtime.isComplete(), true);
});
