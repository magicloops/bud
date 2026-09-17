import test from "node:test";
import assert from "node:assert/strict";
import { BrowserControl } from "./control.js";
import type {
  BrowserControlRepository,
  BrowserSession,
} from "./control-repository.js";
import type { BrowserCarrier, BrowserCommand } from "./transport.js";
import type { BrowserBackendResult } from "../agent/browser-tool-executor.js";
import { BrowserError } from "./repository.js";

function fixture() {
  let session: BrowserSession = {
    id: "browser",
    browser_id: "resource",
    browser_epoch: 1,
    control_session_id: null,
    thread_id: "thread",
    bud_id: "bud",
    created_by_user_id: "alice",
    tenant_id: null,
    generation: "generation",
    boot_id: "boot",
    state: "ready",
    desired_state: "open",
    control_state: "paused",
    control_epoch: 2,
    sequence: 2,
    revision: 1,
    control_request_id: null,
    private_content: false,
  };
  let returned = 0;
  let running = false;
  let fail: string | undefined;
  let rejection: string | undefined;
  const requests: BrowserCommand[] = [];
  let fitReply: BrowserBackendResult | undefined;
  let reopenReply: BrowserBackendResult | undefined;
  let inputReply: Promise<BrowserBackendResult> | undefined;
  let renewalReply: Promise<BrowserBackendResult> | undefined;
  const repository = {
    command(value: BrowserSession, command: Record<string, unknown>) {
      return { session_id: value.id, generation: value.generation, control_epoch: value.control_epoch, sequence: value.sequence, command };
    },
    async get(owner: string) {
      if (owner !== "alice") throw new BrowserError("browser_not_found");
      return { ...session };
    },
    async hasRunningInvocation() {
      return running;
    },
    async requestUser() {
      return { session: { ...session }, created: true };
    },
    async prepare(
      _owner: string,
      _id: string,
      _boot: string,
      revision: number,
      id: string,
      command: Record<string, unknown>,
      state: string,
    ) {
      assert.equal(revision, session.revision);
      const advance = command.action === "control" && command.operation !== "renew";
      session = {
        ...session,
        control_state: state,
        private_content: session.private_content || state === "human_private",
        revision: session.revision + Number(advance),
        sequence: session.sequence + 1,
        control_epoch: session.control_epoch + Number(advance),
        browser_epoch: session.browser_epoch + Number(advance),
      };
      return {
        session: { ...session },
        request: {
          request_id: id,
          session_id: session.id,
          generation: session.generation,
          thread_id: session.thread_id,
          owner_user_id: "alice",
          control_epoch: session.control_epoch,
          sequence: session.sequence,
          invocation_id: "viewer",
          invocation_fence: 1,
          expires_at_ms: Date.now() + 30_000,
          command,
        },
      };
    },
    async pauseAfterFailure() {
      session = {
        ...session,
        control_state: "paused",
        revision: session.revision + 1,
      };
    },
    async returned() {
      returned++;
      session = {
        ...session,
        control_state: "agent",
        private_content: false,
        revision: session.revision + 1,
      };
    },
  } as unknown as BrowserControlRepository;
  const carrier = {
    bootId: "boot",
    handoff: true,
    viewportResize: true,
    current: () => true,
  } as BrowserCarrier;
  const dispatch = async (_carrier: BrowserCarrier, request: BrowserCommand): Promise<BrowserBackendResult> => {
      requests.push(request);
      if (request.command.action === "reopen_pages" && reopenReply) return reopenReply;
      if (request.command.action === "fit_viewport" && fitReply) return fitReply;
      if (request.command.operation === "renew" && renewalReply) return renewalReply;
      if (request.command.action === "human_input" && inputReply) return inputReply;
      if (fail !== undefined && fail === request.command.operation)
        return {
          ok: false,
          outcome: rejection ? "rejected" : "unknown",
          error: rejection ?? "browser_outcome_unknown",
        };
      return {
        ok: true,
        outcome: "completed",
        data: { pages_reopened: true, control_acknowledged: true, viewport_applied: true, viewport_id: "viewport" },
      };
    };
  const control = new BrowserControl(repository, () => carrier, dispatch);
  return {
    control,
    restart: () => new BrowserControl(repository, () => carrier, dispatch),
    set reopenReply(value: BrowserBackendResult) { reopenReply = value; },
    set fitReply(value: BrowserBackendResult) { fitReply = value; },
    set inputReply(value: Promise<BrowserBackendResult>) { inputReply = value; },
    set renewalReply(value: Promise<BrowserBackendResult>) { renewalReply = value; },
    requests,
    carrier,
    get session() {
      return session;
    },
    get returned() {
      return returned;
    },
    set running(value: boolean) {
      running = value;
    },
    set fail(value: string | undefined) {
      fail = value;
    },
    set rejection(value: string | undefined) {
      rejection = value;
    },
  };
}

test("one private controller; renew preserves revision; explicit return acknowledges both boundaries", async () => {
  const f = fixture();
  await assert.rejects(
    f.control.acquire("bob", "browser", "viewer", 1),
    /not_found/,
  );
  await f.control.acquire("alice", "browser", "viewer", 1);
  assert.deepEqual(
    f.requests.map((r) => r.command.operation),
    ["pause", "acquire"],
  );
  await assert.rejects(
    f.control.acquire("alice", "browser", "other", f.session.revision),
    /controller_exists/,
  );
  const revision = f.session.revision;
  await f.control.renew("alice", "browser", "viewer");
  assert.equal(f.session.revision, revision);
  await assert.rejects(
    f.control.returnToAgent("alice", "browser", "other", revision),
    /expired/,
  );
  await f.control.returnToAgent("alice", "browser", "viewer", revision);
  assert.equal(f.session.control_state, "agent");
  assert.equal(f.returned, 1);
  assert.deepEqual(
    f.requests.slice(-2).map((r) => r.command.operation),
    ["prepare_return", "finish_return"],
  );
  await assert.rejects(
    f.control.returnToAgent("alice", "browser", "viewer", revision),
    /expired/,
  );
  assert.equal(f.returned, 1);
});

test("renewal preserves known rejection codes but never exposes arbitrary daemon errors", async () => {
  for (const code of ["browser_control_expired", "browser_stale_request", "private page details"]) {
    const f = fixture();
    await f.control.acquire("alice", "browser", "viewer", 1);
    f.fail = "renew";
    f.rejection = code;
    await assert.rejects(f.control.renew("alice", "browser", "viewer"),
      (error: unknown) => error instanceof BrowserError &&
        error.code === (code === "private page details" ? "browser_control_uncertain" : code));
    assert.equal(f.session.control_state, "paused");
    assert.equal(f.returned, 0);
  }
});

test("release and lost return acknowledgement never make an invocation runnable", async () => {
  for (const operation of ["release", "prepare_return", "finish_return"]) {
    const f = fixture();
    await f.control.acquire("alice", "browser", "viewer", 1);
    if (operation === "release")
      await f.control.release("alice", "browser", "viewer");
    else {
      f.fail = operation;
      await assert.rejects(
        f.control.returnToAgent(
          "alice",
          "browser",
          "viewer",
          f.session.revision,
        ),
        /uncertain/,
      );
    }
    assert.equal(f.session.control_state, "paused");
    assert.equal(f.returned, 0);
    await assert.rejects(
      f.control.renew("alice", "browser", "viewer"),
      /expired/,
    );
  }
});

test("takeover fences browser work without waiting for unrelated invocation work", async () => {
  const f = fixture();
  f.running = true;
  const waiting = await f.control.acquire("alice", "browser", "viewer", 1);
  assert.equal(waiting.control_state, "human_private");
  assert.deepEqual(f.requests.map(request => request.command.operation), ["pause", "acquire"]);
  assert.ok((await f.control.mediaAuthority("alice", "browser", "viewer")).controllerId);

});


test("viewport fits only for the current private controller and capable daemon", async () => {
  const f = fixture();
  const size = { target_id: "page", document_id: "document", width: 700, height: 500 };
  await assert.rejects(f.control.resizeViewport("bob", "browser", "viewer", size), /not_found/);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /expired/);
  await f.control.acquire("alice", "browser", "viewer", 1);
  const revision = f.session.revision;
  const epoch = f.session.control_epoch;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "other", size), /expired/);
  const count = f.requests.length;
  f.carrier.viewportResize = false;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /unsupported/);
  assert.equal(f.requests.length, count);
  f.carrier.viewportResize = true;
  assert.deepEqual(await f.control.resizeViewport("alice", "browser", "viewer", size), { viewport_applied: true, viewport_id: "viewport" });
  assert.equal(f.requests.at(-1)?.command.action, "resize_viewport");
  assert.equal(f.session.revision, revision);
  assert.equal(f.session.control_epoch, epoch);
  await f.control.renew("alice", "browser", "viewer");
  await f.control.release("alice", "browser", "viewer");
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /expired/);
});


test("independent renewal completes during pending input; unknown input fences authority", async () => {
  const f = fixture();
  f.carrier.independentRenewal = true;
  await f.control.acquire("alice", "browser", "viewer", 1);
  let finish!: (result: BrowserBackendResult) => void;
  f.inputReply = new Promise(resolve => { finish = resolve; });
  const pending = f.control.input("alice", "browser", "viewer", {});
  await new Promise(resolve => setImmediate(resolve));
  const revision = f.session.revision;
  const renewed = await f.control.renew("alice", "browser", "viewer");
  assert.equal(renewed.revision, revision);
  assert.equal(f.requests.at(-1)?.command.operation, "renew");
  let fences = 0;
  f.control.onFence = () => { fences++; };
  finish({ ok: false, outcome: "unknown", error: "browser_outcome_unknown" });
  await assert.rejects(pending, /browser_input_uncertain/);
  assert.equal(fences, 1);
  assert.equal(f.session.control_state, "paused");
  await assert.rejects(f.control.renew("alice", "browser", "viewer"), /expired/);
  assert.equal(f.returned, 0);
});


test("late independent renewal cannot restore a released controller", async () => {
  const f = fixture();
  f.carrier.independentRenewal = true;
  await f.control.acquire("alice", "browser", "viewer", 1);
  let finish!: (result: BrowserBackendResult) => void;
  f.renewalReply = new Promise(resolve => { finish = resolve; });
  const pending = f.control.renew("alice", "browser", "viewer");
  await new Promise(resolve => setImmediate(resolve));
  await f.control.release("alice", "browser", "viewer");
  finish({ ok: true, outcome: "completed", data: { control_acknowledged: true } });
  await assert.rejects(pending, /expired/);
  await assert.rejects(f.control.renew("alice", "browser", "viewer"), /expired/);
  assert.equal(f.session.control_state, "paused");
  assert.equal(f.returned, 0);
});


test("history input requires an advertising daemon", async () => {
  const f = fixture();
  await f.control.acquire("alice", "browser", "viewer", 1);
  const count = f.requests.length;
  await assert.rejects(f.control.input("alice", "browser", "viewer", { input: { kind: "back" } }), /history_unsupported/);
  assert.equal(f.requests.length, count);
  f.carrier.historyNavigation = true;
  await f.control.input("alice", "browser", "viewer", { input: { kind: "back" } });
  assert.deepEqual(f.requests.at(-1)?.command.input, { kind: "back" });
});


test("passive fit preserves the invocation sequence and requires the elected live owner viewer", async () => {
  const f = fixture();
  f.session.control_state = "agent";
  f.running = true;
  const size = { target_id: "page", document_id: "document", width: 700, height: 500 };
  await assert.rejects(f.control.resizeViewport("bob", "browser", "viewer", size), /not_found/);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /unsupported/);
  f.carrier.agentViewportResize = true;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /other_viewer/);
  f.control.isSizingViewer = (owner, session, viewer) => owner === "alice" && session.id === "browser" && viewer === "viewer";
  const before = { ...f.session };
  await f.control.resizeViewport("alice", "browser", "viewer", size);
  assert.deepEqual(f.session, before);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].command.action, "fit_viewport");
  assert.equal(f.requests[0].command.controller_id, undefined);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "other", size), /other_viewer/);
  f.session.private_content = true;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size), /expired/);
  assert.equal(f.requests.length, 1);
});


test("unconfirmed passive fit never fences media or changes agent authority", async () => {
  const f = fixture();
  f.session.control_state = "agent";
  f.carrier.agentViewportResize = true;
  f.control.isSizingViewer = () => true;
  let fences = 0;
  f.control.onFence = () => { fences++; };
  f.fitReply = { ok: false, outcome: "unknown" };
  const before = { ...f.session };
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", {
    target_id: "page", document_id: "document", width: 700, height: 500,
  }), /viewport_unconfirmed/);
  assert.deepEqual(f.session, before);
  assert.equal(fences, 0);
  assert.equal(f.requests.length, 1);
});


test("runtime status distinguishes restart from a temporary disconnect without mutating the session", () => {
  const f = fixture();
  const before = { ...f.session };
  assert.equal(f.control.runtimeStatus(f.session), "available");
  f.carrier.current = () => false;
  assert.equal(f.control.runtimeStatus(f.session), "disconnected");
  f.carrier.bootId = "new-boot";
  assert.equal(f.control.runtimeStatus(f.session), "disconnected");
  f.carrier.current = () => true;
  assert.equal(f.control.runtimeStatus(f.session), "daemon_restarted");
  assert.deepEqual(f.session, before);
  assert.equal(f.control.runtimeStatus({ ...f.session, state: "interrupted" }), "daemon_restarted");
  assert.equal(f.control.runtimeStatus({ ...f.session, desired_state: "closed" }), "ended");
  f.carrier.bootId = f.session.boot_id;
  assert.equal(f.control.runtimeStatus({ ...f.session, state: "interrupted" }), "ended");
});

test('persisted private state does not imply live control after service restart', async () => {
  const f = fixture();
  await f.control.acquire('alice', 'browser', 'auth-session:viewer', 1);
  assert.equal(f.control.ownsControl('alice', 'browser', 'auth-session:viewer'), true);
  assert.equal(f.control.ownsControl('alice', 'browser', 'other-session:viewer'), false);
  assert.equal(f.control.ownsControl('bob', 'browser', 'auth-session:viewer'), false);
  const restarted = new BrowserControl(f.control.repository);
  assert.equal(f.session.control_state, 'human_private');
  assert.equal(restarted.ownsControl('alice', 'browser', 'auth-session:viewer'), false);
  await assert.rejects(restarted.returnToAgent('alice', 'browser', 'auth-session:viewer', f.session.revision), /expired/);
  assert.equal(f.returned, 0);
  f.carrier.current = () => false;
  assert.equal(f.control.ownsControl('alice', 'browser', 'auth-session:viewer'), false);
});

test('signed viewer recovery survives coordinator restart, fences old tickets and never returns the agent', async () => {
  const f = fixture();
  const acquired = await f.control.acquire('alice', 'browser', 'auth:viewer', 1);
  const ticket = f.control.recoveryTicket(acquired, 'auth:viewer')!;
  assert.ok(ticket);
  assert.equal(f.control.recoveryTicket(acquired, 'auth:other'), undefined);
  const restarted = f.restart();
  await assert.rejects(restarted.recoverViewer('bob', 'browser', 'auth:viewer', ticket), /not_found/);
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'other-auth:viewer', ticket), /recovery_invalid/);
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'auth:other', ticket), /recovery_invalid/);
  const recovered = await restarted.recoverViewer('alice', 'browser', 'auth:viewer', ticket);
  assert.equal(recovered.private_content, true);
  assert.equal(recovered.control_state, 'human_private');
  assert.ok(recovered.control_epoch > acquired.control_epoch);
  assert.equal(f.returned, 0);
  const requests = f.requests.length;
  // The first response can be lost; retry returns the existing lease only.
  await restarted.recoverViewer('alice', 'browser', 'auth:viewer', ticket);
  assert.equal(f.requests.length, requests);
  const freshTicket = restarted.recoveryTicket(recovered, 'auth:viewer')!;
  assert.notEqual(freshTicket, ticket);
  await restarted.release('alice', 'browser', 'auth:viewer');
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'auth:viewer', ticket), /recovery_invalid/);
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'auth:viewer', freshTicket), /recovery_invalid/);
  const another = await restarted.acquire('alice', 'browser', 'auth:other', f.session.revision);
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'auth:viewer', freshTicket), /controller_exists/);
  const anotherTicket = restarted.recoveryTicket(another, 'auth:other')!;
  await restarted.returnToAgent('alice', 'browser', 'auth:other', another.revision);
  await assert.rejects(restarted.recoverViewer('alice', 'browser', 'auth:other', anotherTicket), /recovery_invalid/);
  assert.equal(f.returned, 1);
});


test("explicit page recovery takes private control first and never resumes agent work", async () => {
  const f = fixture();
  await assert.rejects(f.control.acquire("bob","browser","viewer",1,true), /not_found/);
  assert.equal(f.requests.length,0);
  await f.control.acquire("alice","browser","viewer",1,true);
  assert.deepEqual(f.requests.map(r=>r.command.operation ?? r.command.action),["pause","acquire","reopen_pages","renew"]);
  assert.equal(f.session.private_content,true);
  assert.equal(f.returned,0);
  assert.equal(f.control.ownsControl("alice","browser","viewer"),true);
});

test("unknown or unavailable page recovery is not retried and leaves private state paused", async () => {
  for (const outcome of ["unknown","rejected"] as const) {
    const f = fixture();
    f.reopenReply = {ok:false,outcome,error:"browser_recovery_unavailable"};
    await assert.rejects(f.control.acquire("alice","browser","viewer",1,true), /browser_recovery_/);
    assert.equal(f.requests.filter(r=>r.command.action==="reopen_pages").length,1);
    assert.equal(f.session.private_content,true);
    assert.equal(f.session.control_state,"paused");
    assert.equal(f.control.ownsControl("alice","browser","viewer"),false);
    assert.equal(f.returned,0);
  }
});
