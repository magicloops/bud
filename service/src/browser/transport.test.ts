import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browserCarrier,
  dispatchBrowser,
  receiveBrowserResult,
  type BrowserCarrier,
  type BrowserCommand,
} from "./transport.js";
import { sessions, type SessionTracker } from "../ws/session-trackers.js";
import { grpcSessions } from "../transport/grpc-daemon-router.js";
import { decodeBudFrame, encodeBudFrame } from "../proto/wire.js";
import {
  decodeGrpcLegacyJsonEnvelope,
  encodeGrpcLegacyJsonEnvelope,
} from "../grpc/envelope-codec.js";

const request = (): BrowserCommand => ({
  request_id: randomUUID(),
  session_id: "session",
  generation: "generation",
  thread_id: "thread",
  owner_user_id: "alice",
  browser_id: "managed_fixture",
  browser_epoch: 1,
  private_content: false,
  browser_paused: false,
  control_epoch: 1,
  sequence: 1,
  invocation_id: "invocation",
  invocation_fence: 1,
  expires_at_ms: Date.now() + 2000,
  command: { action: "click", reference: "opaque" },
});
const reply = (r: BrowserCommand) => ({
  browser_version: 1,
  result: {
    request_id: r.request_id,
    session_id: r.session_id,
    generation: r.generation,
    ok: true,
    outcome: "completed",
    data: { observed: true },
  },
});
const capability = {
  version: 1,
  available: true,
  boot_id: "boot",
  managed: true,
  profile_mode: "persistent",
};
function fixture() {
  const tracker = {
    budId: randomUUID(),
    sessionId: randomUUID(),
  } as SessionTracker;
  const frames: Record<string, unknown>[] = [];
  const carrier: BrowserCarrier = {
    tracker,
    bootId: "boot",
    current: () => true,
    send: (frame) => {
      frames.push(frame);
      return true;
    },
  };
  return { carrier, frames };
}

test("browser protobuf frames survive both control encodings", () => {
  for (const frame of [
    { type: "browser_command", browser_version: 1, request: { ...request(), browser_color: "#EB63DC", command: { action: "open" } } },
    { type: "browser_command", browser_version: 1, request: { ...request(), command: { action: "resize_viewport", controller_id: "controller", target_id: "page", document_id: "document", width: 640, height: 480 } } },
    { type: "browser_command", browser_version: 1, request: { ...request(), command: { action: "media_attach", endpoint: "wss://service.test/ws/browser-media", ticket: "fixture", controller_id: null, operation_driven: true } } },
    { type: "browser_result", ...reply(request()) },
  ]) {
    const input = {
      proto: "0.1",
      id: "message",
      ts: Date.now(),
      ext: {},
      ...frame,
    };
    assert.deepEqual(decodeBudFrame(encodeBudFrame(input)), input);
    assert.deepEqual(
      decodeGrpcLegacyJsonEnvelope(
        encodeGrpcLegacyJsonEnvelope(input, { transportKind: "h2_grpc" }),
      ),
      input,
    );
  }
});
test("results require the exact authenticated tracker and session generation", async () => {
  const { carrier } = fixture();
  const r = request();
  const pending = dispatchBrowser(carrier, r, new AbortController().signal);
  receiveBrowserResult({ ...carrier.tracker }, reply(r));
  receiveBrowserResult(carrier.tracker, reply({ ...r, generation: "foreign" }));
  receiveBrowserResult(carrier.tracker, reply(r));
  assert.equal((await pending).ok, true);
});
test("abort sends one cancellation and never retries the mutation", async () => {
  const { carrier, frames } = fixture();
  const r = request();
  const abort = new AbortController();
  const pending = dispatchBrowser(carrier, r, abort.signal);
  abort.abort();
  assert.equal((await pending).outcome, "unknown");
  assert.equal(frames.length, 2);
  assert.deepEqual((frames[1].request as BrowserCommand).command, {
    action: "cancel",
  });
  receiveBrowserResult(carrier.tracker, reply(r));
  assert.equal(frames.length, 2);
});
test("unsent rejection differs from send exceptions and disconnected outcomes", async () => {
  const { carrier } = fixture();
  assert.equal(
    (
      await dispatchBrowser(
        { ...carrier, send: () => false },
        request(),
        new AbortController().signal,
      )
    ).outcome,
    "rejected",
  );
  assert.equal(
    (
      await dispatchBrowser(
        {
          ...carrier,
          send: () => {
            throw Error("write failed");
          },
        },
        request(),
        new AbortController().signal,
      )
    ).outcome,
    "unknown",
  );
  let current = true;
  const pending = dispatchBrowser(
    { ...carrier, current: () => current },
    request(),
    new AbortController().signal,
  );
  current = false;
  assert.equal((await pending).outcome, "unknown");
});
test("old daemon capability is omitted; captured carrier cannot move to a replacement socket", async (t) => {
  const id = randomUUID();
  const sent: Buffer[] = [];
  const tracker = {
    budId: id,
    sessionId: "device",
    lastHeartbeat: Date.now(),
    socket: {
      readyState: 1,
      OPEN: 1,
      send: (v: Buffer) => {
        sent.push(v);
      },
    },
  } as unknown as SessionTracker;
  sessions.set(id, tracker);
  t.after(() => {
    sessions.delete(id);
    grpcSessions.delete(id);
  });
  assert.equal(browserCarrier(id), null);
  tracker.browserCapability = capability;
  const carrier = browserCarrier(id)!;
  assert.ok(carrier);
  assert.equal(carrier.viewportResize, false);
  assert.equal(carrier.independentRenewal, false);
  assert.equal(carrier.hidpiCapture, false);
  assert.equal(carrier.operationDrivenMedia, false);
  tracker.browserCapability = { ...capability, handoff: true, viewport_resize: true, independent_renewal: true, hidpi_capture: true, operation_driven_media: true };
  assert.equal(browserCarrier(id)?.viewportResize, true);
  assert.equal(browserCarrier(id)?.independentRenewal, true);
  assert.equal(browserCarrier(id)?.hidpiCapture, true);
  assert.equal(browserCarrier(id)?.operationDrivenMedia, true);
  sessions.set(id, { ...tracker, sessionId: "replacement" });
  assert.equal(
    (await dispatchBrowser(carrier, request(), new AbortController().signal))
      .outcome,
    "rejected",
  );
  assert.equal(sent.length, 0);
});
