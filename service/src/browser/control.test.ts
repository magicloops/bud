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

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

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
    override_id:null,override_viewer_id:null,override_carrier_id:null,override_expires_at:null,ended_override_id:null,override_end_reason:null,
  };
  let returned = 0;
  let running = false;
  let fail: string | undefined;
  let rejection: string | undefined;
  const requests: BrowserCommand[] = [];
  let fitReply: BrowserBackendResult | undefined;
  let windowReply: BrowserBackendResult | undefined;
  let ensureReply: BrowserBackendResult | Promise<BrowserBackendResult> | undefined;
  let inputReply: Promise<BrowserBackendResult> | undefined;
  let renewalReply: Promise<BrowserBackendResult> | undefined;
  const repository = {
    async grantOverride(_owner:string,_id:string,_revision:number,id:string,viewer:string,carrier:string,expires:number) {
      Object.assign(session,{override_id:id,override_viewer_id:viewer,override_carrier_id:carrier,override_expires_at:new Date(expires)});
    },
    async renewOverride(_owner:string,_id:string,id:string,_viewer:string,_carrier:string,expires:number) {
      if(session.override_id!==id) throw new BrowserError("browser_control_expired");
      session.override_expires_at=new Date(expires);
    },
    async endOverride(_owner:string,_id:string,id:string,reason:string) {
      if(session.override_id!==id) return false;
      Object.assign(session,{ended_override_id:id,override_id:null,override_viewer_id:null,override_carrier_id:null,override_expires_at:null,override_end_reason:reason,revision:session.revision+1});
      return true;
    },
    async reconciliationCandidates() { return session.control_state!=="agent" && !session.override_id ? [{...session}] : []; },
    async prepareEnd(candidate:BrowserSession,boot:string) {
      const prepared=await repository.prepare(candidate.created_by_user_id,candidate.id,boot,session.revision,"end",{action:"control",operation:"end"},"resume_pending");
      return {...prepared,resource:prepared.session};
    },
    async acknowledgeEnd() { returned++; session = {...session,control_state:"agent",private_content:false,revision:session.revision+1}; },
    async failEnd() { return repository.pauseAfterFailure("alice","browser",session.revision); },
    command(value: BrowserSession, command: Record<string, unknown>) {
      return { session_id: value.id, generation: value.generation, control_epoch: value.control_epoch, sequence: value.sequence, command };
    },
    async get(owner: string) {
      if (owner !== "alice") throw new BrowserError("browser_not_found");
      return { ...session };
    },
    async pending() { return returned ? null : {id:"handoff"}; },
    async hasRunningInvocation() {
      return running;
    },
    async requestUser() {
      return { session: { ...session }, created: true };
    },
    async prepareEnsure(owner:string, _id:string, boot:string, explicitUrl:boolean) {
      if(owner !== "alice") throw new BrowserError("browser_not_found");
      return {session:{...session},resource:{...session},request:{command:{action:"ensure",explicit_url:explicitUrl}}};
    },
    async acknowledgeRecovery() {
      session={...session,control_state:"agent",private_content:false,revision:session.revision+1,browser_epoch:session.browser_epoch+1};
    },
    async ensured() { return {...session}; },
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
        control_session_id: advance ? session.id : session.control_session_id,
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

  } as unknown as BrowserControlRepository;
  const carrier = {
    tracker: {sessionId:"carrier"},
    bootId: "boot",
    handoff: true,
    viewportResize: true,
    current: () => true,
  } as BrowserCarrier;
  const dispatch = async (_carrier: BrowserCarrier, request: BrowserCommand): Promise<BrowserBackendResult> => {
      requests.push(request);
      if (request.command.action === "native_window" && windowReply) return windowReply;
      if (request.command.action === "ensure" && ensureReply) return ensureReply;
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
        data: { window_acknowledged: true, ensured: true, runtime_replaced:false, recovery_status:"ready", control_acknowledged: true, viewport_applied: true, viewport_id: "viewport" },
      };
    };
  const control = new BrowserControl(repository, () => carrier, dispatch);
  return {
    control,
    restart: () => new BrowserControl(repository, () => carrier, dispatch),
    set windowReply(value: BrowserBackendResult) { windowReply = value; },
    set ensureReply(value: BrowserBackendResult | Promise<BrowserBackendResult>) { ensureReply = value; },
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
  await f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old");
  assert.equal(f.session.revision, revision);
  await assert.rejects(
    f.control.returnToAgent("alice", "browser", "other", revision, f.session.override_id ?? "old"),
    /expired/,
  );
  await f.control.returnToAgent("alice", "browser", "viewer", revision, f.session.override_id ?? "old");
  await settle();
  assert.equal(f.session.control_state, "agent");
  assert.equal(f.returned, 1);
  assert.deepEqual(
    f.requests.slice(-1).map((r) => r.command.operation),
    ["end"],
  );
  await f.control.returnToAgent("alice", "browser", "viewer", revision, "retired-id");
  assert.equal(f.returned, 1);
});

test("renewal preserves known rejection codes but never exposes arbitrary daemon errors", async () => {
  for (const code of ["browser_control_expired", "browser_stale_request", "private page details"]) {
    const f = fixture();
    await f.control.acquire("alice", "browser", "viewer", 1);
    f.fail = "renew";
    f.rejection = code;
    await assert.rejects(f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old"),
      (error: unknown) => error instanceof BrowserError &&
        error.code === (code === "private page details" ? "browser_control_uncertain" : code));
    assert.equal(f.session.override_id, null);
    assert.equal(f.returned, 0);
  }
});

test("release retires immediately; unknown end acknowledgement retries without human intervention", async () => {
  const f = fixture();
  await f.control.acquire("alice","browser","viewer",1);
  const old = f.session.override_id!;
  f.fail = "end";
  await f.control.release("alice","browser","viewer",old);
  assert.equal(f.session.override_id,null);
  await settle();
  assert.equal(f.returned,0);
  await assert.rejects(f.control.renew("alice","browser","viewer",old),/expired/);
  f.fail = undefined;
  await f.control.reconcile();
  assert.equal(f.returned,1);
  await f.control.acquire("alice","browser","viewer",f.session.revision);
  const current = f.session.override_id;
  await f.control.release("alice","browser","viewer",old);
  assert.equal(f.session.override_id,current);
  await assert.rejects(f.control.input("alice","browser","viewer",{override_id:old}),/expired/);
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
  await assert.rejects(f.control.resizeViewport("bob", "browser", "viewer", size, f.session.override_id ?? undefined), /not_found/);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /expired/);
  await f.control.acquire("alice", "browser", "viewer", 1);
  const revision = f.session.revision;
  const epoch = f.session.control_epoch;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "other", size), /expired/);
  const count = f.requests.length;
  f.carrier.viewportResize = false;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /unsupported/);
  assert.equal(f.requests.length, count);
  f.carrier.viewportResize = true;
  assert.deepEqual(await f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), { viewport_applied: true, viewport_id: "viewport" });
  assert.equal(f.requests.at(-1)?.command.action, "resize_viewport");
  assert.equal(f.session.revision, revision);
  assert.equal(f.session.control_epoch, epoch);
  await f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old");
  await f.control.release("alice", "browser", "viewer", f.session.override_id ?? "old");
  await settle();
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /expired|unsupported/);
});


test("independent renewal completes during pending input; unknown input fences authority", async () => {
  const f = fixture();
  f.carrier.independentRenewal = true;
  await f.control.acquire("alice", "browser", "viewer", 1);
  let finish!: (result: BrowserBackendResult) => void;
  f.inputReply = new Promise(resolve => { finish = resolve; });
  const pending = f.control.input("alice", "browser", "viewer", {override_id:f.session.override_id});
  await new Promise(resolve => setImmediate(resolve));
  const revision = f.session.revision;
  const renewed = await f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old");
  assert.equal(renewed.revision, revision);
  assert.equal(f.requests.at(-1)?.command.operation, "renew");
  let fences = 0;
  f.control.onFence = () => { fences++; };
  finish({ ok: false, outcome: "unknown", error: "browser_outcome_unknown" });
  await assert.rejects(pending, /browser_input_uncertain/);
  assert.equal(fences, 1);
  assert.equal(f.session.override_id, null);
  await assert.rejects(f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old"), /expired/);
  assert.equal(f.returned, 0);
});


test("late independent renewal cannot restore a released controller", async () => {
  const f = fixture();
  f.carrier.independentRenewal = true;
  await f.control.acquire("alice", "browser", "viewer", 1);
  let finish!: (result: BrowserBackendResult) => void;
  f.renewalReply = new Promise(resolve => { finish = resolve; });
  const pending = f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old");
  await new Promise(resolve => setImmediate(resolve));
  await f.control.release("alice", "browser", "viewer", f.session.override_id ?? "old");
  finish({ ok: true, outcome: "completed", data: { control_acknowledged: true } });
  await assert.rejects(pending, /expired/);
  await assert.rejects(f.control.renew("alice", "browser", "viewer", f.session.override_id ?? "old"), /expired/);
  assert.equal(f.session.override_id, null);
  await settle();
  assert.equal(f.returned, 1);
});


test("history input requires an advertising daemon", async () => {
  const f = fixture();
  await f.control.acquire("alice", "browser", "viewer", 1);
  const count = f.requests.length;
  await assert.rejects(f.control.input("alice", "browser", "viewer", { override_id:f.session.override_id, input: { kind: "back" } }), /history_unsupported/);
  assert.equal(f.requests.length, count);
  f.carrier.historyNavigation = true;
  await f.control.input("alice", "browser", "viewer", { override_id:f.session.override_id, input: { kind: "back" } });
  assert.deepEqual(f.requests.at(-1)?.command.input, { kind: "back" });
});


test("passive fit preserves the invocation sequence and requires the elected live owner viewer", async () => {
  const f = fixture();
  f.session.control_state = "agent";
  f.running = true;
  const size = { target_id: "page", document_id: "document", width: 700, height: 500 };
  await assert.rejects(f.control.resizeViewport("bob", "browser", "viewer", size, f.session.override_id ?? undefined), /not_found/);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /unsupported/);
  f.carrier.agentViewportResize = true;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /other_viewer/);
  f.control.isSizingViewer = (owner, session, viewer) => owner === "alice" && session.id === "browser" && viewer === "viewer";
  const before = { ...f.session };
  await f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined);
  assert.deepEqual(f.session, before);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].command.action, "fit_viewport");
  assert.equal(f.requests[0].command.controller_id, undefined);
  await assert.rejects(f.control.resizeViewport("alice", "browser", "other", size), /other_viewer/);
  f.session.private_content = true;
  await assert.rejects(f.control.resizeViewport("alice", "browser", "viewer", size, f.session.override_id ?? undefined), /expired/);
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
  await restarted.returnToAgent('alice', 'browser', 'auth-session:viewer', f.session.revision, f.session.override_id!);
  assert.equal(f.session.override_id,null);
  assert.equal(f.returned, 0);
  f.carrier.current = () => false;
  assert.equal(f.control.ownsControl('alice', 'browser', 'auth-session:viewer'), false);
});


test("ensure clears private authority only after confirmed runtime replacement", async () => {
  const f=fixture();
  await f.control.acquire("alice","browser","viewer",1);
  await assert.rejects(f.control.ensure("bob","browser"),/not_found/);
  await f.control.ensure("alice","browser");
  assert.equal(f.session.private_content,true);
  assert.equal(f.control.ownsControl("alice","browser","viewer"),true);
  f.carrier.bootId="new-boot";
  f.ensureReply={ok:false,outcome:"rejected",error:"browser_profile_recovery_required"};
  await assert.rejects(f.control.ensure("alice","browser"),/profile_recovery_required/);
  assert.equal(f.session.private_content,true);
  f.ensureReply={ok:true,outcome:"completed",data:{ensured:true,runtime_replaced:true,recovery_status:"restored"}};
  const result=await f.control.ensure("alice","browser");
  assert.equal(result.private_progress_lost,true);
  assert.equal(f.session.private_content,false);
  assert.equal(f.control.ownsControl("alice","browser","viewer"),false);
  assert.equal(f.returned,0,"restart is not a user return");
});

test("native reveal takes private authority first; hide preserves it and return hides before releasing", async () => {
  const f = fixture(); f.carrier.nativeWindow = true;
  await assert.rejects(f.control.nativeWindow("bob","browser","viewer",1,true), /not_found/);
  assert.equal(f.requests.length,0);
  await f.control.nativeWindow("alice","browser","viewer",1,true,"page");
  assert.deepEqual(f.requests.map(r=>r.command.operation ?? r.command.action),["pause","acquire","native_window"]);
  assert.equal(f.requests.at(-1)?.command.target_id,"page");
  assert.equal(f.session.private_content,true);
  await assert.rejects(f.control.nativeWindow("alice","browser","other",f.session.revision,true), /controller_exists/);
  await assert.rejects(f.control.nativeWindow("alice","browser","other",f.session.revision,false), /expired/);
  await assert.rejects(f.control.nativeWindow("alice","browser","viewer",1,true), /revision_conflict/);
  await f.control.nativeWindow("alice","browser","viewer",f.session.revision,false,undefined,f.session.override_id ?? undefined);
  assert.equal(f.returned,0);
  assert.equal(f.control.ownsControl("alice","browser","viewer"),true);
  await f.control.returnToAgent("alice","browser","viewer",f.session.revision, f.session.override_id ?? "old");
  await settle();
  assert.deepEqual(f.requests.slice(-2).map(r=>r.command.operation ?? r.command.action),["native_window","end"]);
  assert.equal(f.requests.at(-2)?.command.show,false);
  assert.equal(f.returned,1);
});

test("failed end retires human ownership while execution remains fenced", async () => {
  const f=fixture();
  await f.control.acquire("alice","browser","viewer",1);
  f.fail="end";
  await f.control.returnToAgent("alice","browser","viewer",f.session.revision,f.session.override_id!);
  await settle();
  assert.equal(f.session.override_id,null);
  assert.equal(f.control.ownsControl("alice","browser","viewer"),false);
  assert.equal(f.returned,0);
});

test("unsupported native windows cannot acquire control or dispatch", async () => {
  const f = fixture();
  await assert.rejects(f.control.nativeWindow("alice","browser","viewer",1,true), /window_unsupported/);
  assert.equal(f.requests.length,0);
});


test("interrupted open workspaces allow explicit takeover but closed or offline ones do not", () => {
  const f = fixture();
  f.session.state = "interrupted";
  f.session.private_content = true;
  assert.equal(f.control.canTakeControl(f.session), true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.control.canTakeControl({ ...f.session, desired_state: "closed" }), false);
  assert.equal(f.control.canTakeControl({ ...f.session, state: "closed" }), false);
  f.carrier.current = () => false;
  assert.equal(f.control.canTakeControl(f.session), false);
});

test("renew resolves ownership before consulting controller state", async () => {
  for (const independent of [false, true]) {
    const f = fixture();
    f.carrier.independentRenewal = independent;
    await assert.rejects(f.control.renew("bob", "browser", "viewer", f.session.override_id ?? "old"), /not_found/);
    await f.control.acquire("alice", "browser", "viewer", 1);
    const count = f.requests.length;
    await assert.rejects(f.control.renew("bob", "browser", "viewer", f.session.override_id ?? "old"), /not_found/);
    assert.equal(f.requests.length, count);
    assert.equal(f.control.ownsControl("alice", "browser", "viewer"), true);
  }
});


test("concurrent ensures share a single recovery; uncertain acknowledgements keep privacy", async () => {
  const f = fixture();
  await f.control.acquire("alice", "browser", "viewer", 1);
  let finish!: (result: BrowserBackendResult) => void;
  f.ensureReply = new Promise(resolve => { finish = resolve; });
  const first = f.control.ensure("alice", "browser");
  const second = f.control.ensure("alice", "browser");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(r => r.command.action === "ensure").length, 1);
  finish({ok:false, outcome:"unknown", error:"browser_outcome_unknown"});
  await Promise.all([assert.rejects(first, /recovery_uncertain/), assert.rejects(second, /recovery_uncertain/)]);
  assert.equal(f.session.private_content, true);
  assert.equal(f.returned, 0);
});


test("chat return never acquires a controller to return it", async () => {
  const f=fixture();
  await assert.rejects(f.control.returnFromChat("alice","browser","handoff",f.session.revision),/expired/);
  assert.equal(f.requests.length,0);
  await f.control.acquire("alice","browser","viewer",1);
  await f.control.returnFromChat("alice","browser","handoff",f.session.revision);
  await settle();
  assert.deepEqual(f.requests.map(r=>r.command.operation),["pause","acquire","end"]);
  assert.equal(f.returned,1);
});

test('editable focus hint is boolean-only and scoped to the private controller', async () => {
  const f = fixture();
  await f.control.acquire('alice', 'browser', 'viewer', 1);
  for (const data of [{focus_token:'token',focus_editable:true}, {focus_token:'token',focus_editable:'true'}, {focus_token:null,focus_editable:true}]) {
    f.inputReply = Promise.resolve({ok:true,outcome:'completed',data});
    await assert.rejects(f.control.input('bob','browser','viewer',{override_id:f.session.override_id}), /not_found/);
    await assert.rejects(f.control.input('alice','browser','other',{}), /expired/);
    const result = await f.control.input('alice','browser','viewer',{override_id:f.session.override_id});
    assert.equal(result.focus_editable, data.focus_token !== null && data.focus_editable === true);
  }
});

test('click focus diagnostics omit private payloads and distinguish missing hints', async () => {
  const f = fixture();
  await f.control.acquire('alice', 'browser', 'viewer', 1);
  const diagnostics: Record<string, string | number | boolean>[] = [];
  f.control.onDiagnostic = fields => diagnostics.push(fields);
  for (const data of [{focus_token:'secret-token'}, {focus_token:'secret-token', focus_editable:false}, {focus_token:'secret-token', focus_editable:true}]) {
    f.inputReply = Promise.resolve({ok:true,outcome:'completed',data});
    await f.control.input('alice','browser','viewer',{override_id:f.session.override_id,input:{kind:'click',x:123,y:456}});
    assert.deepEqual(diagnostics.pop(), {session_id:'browser',event:'input_focus',input_kind:'click',
      hint_present:typeof data.focus_editable === 'boolean',has_focus_token:true,focus_editable:data.focus_editable === true});
  }
  await f.control.input('alice','browser','viewer',{override_id:f.session.override_id,input:{kind:'text',text:'private text'}});
  await f.control.input('alice','browser','viewer',{override_id:f.session.override_id,input:{kind:'scroll',delta_y:200}});
  assert.deepEqual(diagnostics, []);
});


test("revoking a mobile visit ends only its own override", async () => {
  const f = fixture();
  await f.control.acquire("alice", "browser", "mobile_visit-a:viewer", 1);
  const first = f.session.override_id;
  await f.control.releaseVisit("alice", "browser", "visit-b");
  await f.control.releaseVisit("bob", "browser", "visit-a");
  assert.equal(f.session.override_id, first);
  await f.control.releaseVisit("alice", "browser", "visit-a");
  await settle();
  assert.equal(f.session.control_state, "agent");
  await f.control.acquire("alice", "browser", "mobile_visit-b:viewer", f.session.revision);
  const second = f.session.override_id;
  await f.control.releaseVisit("alice", "browser", "visit-a");
  assert.equal(f.session.override_id, second);
});
