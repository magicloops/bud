# Review: Service Open Core And Horizontal Scaling

Reviewed: 2026-06-06

## Context

Bud wants to open source the repo while keeping a future enterprise-licensed production infrastructure layer. The desired shape is not two unrelated backends. The desired shape is a useful open source `service/` that works for one person or one self-hosted backend, and that the enterprise layer can reuse as the core domain, protocol, and runtime building block.

This review focuses on `service/`: what is already a good OSS core, what currently prevents horizontal scaling, and what should be extracted into enterprise infrastructure without hollowing out the open source server.

Licensing note: this is architecture and product-licensing strategy, not legal advice. Counsel should review the final license choice, contributor terms, trademark policy, and any enterprise-source boundary before release.

## Source Material

Primary local sources reviewed:

- [`../service/service.spec.md`](../service/service.spec.md)
- [`../service/src/src.spec.md`](../service/src/src.spec.md)
- [`../service/src/server.ts`](../service/src/server.ts)
- [`../service/src/config.ts`](../service/src/config.ts)
- [`../service/src/db/schema.ts`](../service/src/db/schema.ts)
- [`../service/src/db/db.spec.md`](../service/src/db/db.spec.md)
- [`../service/src/auth/auth.spec.md`](../service/src/auth/auth.spec.md)
- [`../service/src/routes/routes.spec.md`](../service/src/routes/routes.spec.md)
- [`../service/src/routes/threads/threads.spec.md`](../service/src/routes/threads/threads.spec.md)
- [`../service/src/runtime/runtime.spec.md`](../service/src/runtime/runtime.spec.md)
- [`../service/src/runtime/terminal/terminal.spec.md`](../service/src/runtime/terminal/terminal.spec.md)
- [`../service/src/transport/transport.spec.md`](../service/src/transport/transport.spec.md)
- [`../service/src/ws/ws.spec.md`](../service/src/ws/ws.spec.md)
- [`../service/src/grpc/grpc.spec.md`](../service/src/grpc/grpc.spec.md)
- [`../service/src/agent/agent.spec.md`](../service/src/agent/agent.spec.md)
- [`../service/src/files/files.spec.md`](../service/src/files/files.spec.md)
- [`../service/src/proxy/proxy.spec.md`](../service/src/proxy/proxy.spec.md)
- [`../service/src/llm/llm.spec.md`](../service/src/llm/llm.spec.md)
- [`../docs/proto.md`](../docs/proto.md)

External licensing context:

- Apache License 2.0 has an explicit patent grant and patent-termination clause. Source: <https://www.apache.org/licenses/LICENSE-2.0.html>
- MIT is OSI approved and very permissive. Source: <https://opensource.org/license/mit>
- Elastic's own licensing FAQ documents the 2021 move from Apache 2.0 to SSPL/Elastic License and the 2024 addition of AGPLv3 as an OSI-approved option. Source: <https://www.elastic.co/pricing/faq/licensing/>

## Executive Summary

`service/` is already a usable single-node core service, not merely a prototype shell. It has durable domain state for users, Buds, threads, messages, terminal sessions, terminal output, daemon operations, streams, proxy/file sessions, LLM calls, context checkpoints, and notification outbox rows. Browser-facing routes increasingly enforce ownership through `created_by_user_id`. Those are exactly the pieces that should remain in the open source service.

The service is not horizontally scalable today. The blocker is not the database schema. The blocker is that active execution state is held inside one Node.js process: daemon connection trackers, terminal request waiters, live SSE buffers, agent turn controllers, user-question promises, proxy/file stream bridges, local LLM streams, WebSocket proxy sessions, gateway drain state, and runtime carrier health. A second service process can read many durable rows, but it cannot complete most live work unless the relevant Bud socket, browser response, and in-memory runtime object are on that same process.

The right split is not "OSS backend" versus "enterprise backend." The right split is:

- OSS core: Fastify API, auth/session basics, single-node daemon gateway, thread/message/terminal/agent/proxy/file/local-LLM domain logic, Postgres schema, migrations, protocol codec, and in-memory/default adapters.
- Enterprise layer: distributed connection registry, command broker, worker queue, lease manager, event bus, stream gateway, tenant/org/RBAC/SSO/SCIM, usage metering, quota/rate limiting, secrets proxy/BYOK, audit export, fleet management, production deployment/drain/observability tooling.

This keeps the open source service genuinely useful while protecting commercial value in production-scale infrastructure and operational controls.

## Current Service Shape

`buildServer()` in [`../service/src/server.ts`](../service/src/server.ts) creates one Fastify application that does all roles in one process:

- HTTP REST API and SSE streams for the browser.
- Better Auth request handling.
- WebSocket daemon gateway at `/ws`.
- Optional gRPC control/data gateways.
- Agent runtime and in-process agent execution.
- Terminal session manager and idle monitor.
- Proxy/file/local LLM data-plane stream handling.
- Push notification worker.

The database is a shared Postgres store through a process singleton pool in [`../service/src/db/client.ts`](../service/src/db/client.ts), with a separate auth pool in [`../service/src/auth/auth.ts`](../service/src/auth/auth.ts). The model provider registry is initialized from process environment in [`../service/src/llm/index.ts`](../service/src/llm/index.ts).

That is coherent for a self-hosted single-node service. It is also the source of most scaling constraints.

## What Is Already Good OSS Core

### Durable Product Model

The schema is much more than a toy backend:

- Bud identity, device auth, install claims.
- Thread, message, thread read state.
- LLM calls and provider-native call items.
- Context checkpoints and agent question requests.
- Terminal session records, input logs, and output chunks.
- Durable daemon device sessions, transport sessions, operations, streams, and audit events.
- Proxy sessions, proxied sites, viewer grants/sessions, and file sessions.
- Push endpoints and notification outbox.

This is valuable open source functionality. It should not be moved behind enterprise licensing merely because enterprise infrastructure will eventually consume the same tables.

### Ownership Boundaries

Most browser routes now resolve a `Viewer` and filter SQL by `created_by_user_id` before returning resources. Examples include Bud inventory, threads, messages, terminal history, file sessions, proxy sessions, proxied sites, and model listing with Bud-local models. This is a core correctness property, not an enterprise add-on.

The remaining tenancy gap is organization/tenant semantics. `tenant_id` columns exist in many tables but are nullable and not actively used as a request scoping primitive.

### Protocol And Runtime Foundations

The wire protocol has a WebSocket baseline, optional gRPC carriers, a typed envelope direction, durable operation/stream tables, and replay/reconnect concepts in [`../docs/proto.md`](../docs/proto.md). That is the right foundation for both self-hosted and production use.

The important caveat is that the durable operation/stream model is ahead of the live routing implementation. The rows describe work; they do not yet make live work relocatable across processes.

### LLM Provider Abstraction

The LLM layer has a clean provider registry, product model catalog, provider-specific stream normalization, provider ledger, and context compaction/checkpointing. The enterprise gap is not basic provider abstraction. It is tenant-scoped credentials, model entitlements, budgets, and usage recording.

## Horizontal Scaling Blockers

### 1. Daemon Connection Routing Is Process-Local

Active WebSocket Bud sessions are stored in the module-level `sessions` map in [`../service/src/ws/session-trackers.ts`](../service/src/ws/session-trackers.ts). Active gRPC control sessions are stored in `grpcSessions` in [`../service/src/transport/grpc-daemon-router.ts`](../service/src/transport/grpc-daemon-router.ts). Active data-plane carriers are stored in `dataPlaneSessions` in [`../service/src/transport/data-plane-router.ts`](../service/src/transport/data-plane-router.ts).

`daemonTransportRouter.sendFrameToBud(...)` only works if the target Bud is connected to the same service instance. If a browser request lands on instance B while the Bud is connected to instance A, B sees the Bud as offline or unavailable even though the database says there is a recent online session.

Enterprise requirement:

- A distributed daemon connection registry keyed by Bud/device/transport/session.
- A command broker or gateway RPC that can route frames to the process that owns the live socket.
- A durable definition of "connection owner" and "connection generation" so stale instances cannot mark a Bud offline after another instance has taken over.
- Drain and placement controls that are not process-local.

OSS default:

- Keep the current in-memory registry, but name it explicitly as the single-node implementation.

### 2. Bud Online Status Is Not Authoritative Across Instances

`bud.status` and `last_seen_at` are updated by whichever connection handler observes hello, heartbeat, close, or timeout. In one process this is mostly fine. In multiple processes, close/timeout from a superseded or partitioned process can race with a newer connection on another process.

The durable `device_session` and `transport_session` tables are a good start, especially with `gateway_instance_id`, heartbeat, drain, and close metadata. They are not yet used as the sole authority for browser-visible online state.

Enterprise requirement:

- Treat active transport session ownership as the source of truth.
- Derive Bud online state from non-draining, non-closed transport sessions with fresh heartbeat and current connection generation.
- Guard offline transitions so stale connection handlers cannot overwrite newer presence.

### 3. Agent Turns Are In-Process Jobs

Posting a user message inserts a `message` row, then calls `agentService.startUserMessage(...)` from the request handler in [`../service/src/routes/threads/messages.ts`](../service/src/routes/threads/messages.ts). `AgentService` starts a turn in `AgentRuntimeStateManager`, stores an `AbortController` in `AgentCancellationRegistry`, and launches `runAgentFlow(...)` with `void`.

The durable transcript and provider ledger are strong, but active turn ownership is not durable:

- Cancellation is a local `Map<string, AbortController>`.
- Thread transition serialization is a local `Map<string, Promise<void>>`.
- Pending `ask_user_questions` tool waits are local promises.
- Runtime draft state and stream cursor are local.
- No worker lease says "worker X owns thread Y turn Z until timestamp T."

If the process dies, the transcript is reconstructable but the active turn is gone. If a second process receives `/cancel`, it cannot abort the original process. If an answer to an agent question lands on the wrong instance, it falls back into a user message instead of resolving the live tool wait.

Enterprise requirement:

- Durable `agent_turn` or `run` state with states such as queued, leased, running, awaiting_user, cancel_requested, succeeded, failed, canceled.
- A queue/lease mechanism with worker heartbeat and recovery.
- Idempotent start semantics keyed by message or turn.
- Cancellation through durable state plus worker notification.
- A continuation model for user questions that does not require resolving an in-memory promise on the same process.

OSS default:

- The current local runner is acceptable if documented as the single-node execution adapter.

### 4. Agent SSE Is Local And Short-Lived

`AgentRuntimeStateManager` in [`../service/src/runtime/agent-runtime-state.ts`](../service/src/runtime/agent-runtime-state.ts) keeps listeners, snapshots, and a bounded in-memory event buffer. It is designed for local live UX with a short resume window. It is not a distributed event log.

If agent events are produced on instance A and the browser SSE stream is connected to instance B, B cannot stream those events. The persisted messages can eventually reconstruct the transcript, but draft deltas, reasoning deltas, tool-call progress, compaction events, and live final events are not globally available.

Enterprise requirement:

- A distributed agent event bus or durable event table with cursor semantics.
- Replay semantics independent of the serving process.
- A clear contract for which events are durable, which are ephemeral, and how the UI resyncs.

Potential OSS implementation:

- Keep in-memory SSE for single-node.
- Optionally add a Postgres-backed or `LISTEN/NOTIFY` event adapter later without requiring enterprise code.

### 5. Terminal Request Waiters Are Local

Terminal output is durable in `terminal_session_output`, and terminal history reads can work from any process. The live command path is not distributed.

`TerminalRequestDispatcher` in [`../service/src/runtime/terminal/request-dispatcher.ts`](../service/src/runtime/terminal/request-dispatcher.ts) keeps pending observe/send promises in local maps. The daemon result frame must return to the same process that created the pending request. Readiness and inferred terminal context are also local maps in [`../service/src/runtime/terminal/runtime-state.ts`](../service/src/runtime/terminal/runtime-state.ts).

If a terminal send is issued from instance A and the daemon result arrives at instance B, B logs an orphaned result and A eventually times out. If the Bud reconnects elsewhere mid-turn, the running agent may keep waiting on local state that can no longer complete.

Enterprise requirement:

- A terminal request broker with durable request IDs and response routing.
- Either sticky ownership of each thread terminal to one worker/gateway, or a response bus that routes terminal results back to the requester.
- Durable cancellation/interrupt state, not just local promise rejection.
- A readiness/context cache that can be rebuilt from terminal observe results or shared through a distributed cache.

### 6. Terminal Live SSE Is Local

`TerminalEventBus` in [`../service/src/runtime/event-bus.ts`](../service/src/runtime/event-bus.ts) stores listeners and replay buffers locally. Terminal output chunks are persisted, but the live event stream and buffer cursor are not distributed.

This is less severe than agent events because terminal history can be pulled from Postgres by byte offset. Still, a browser attached to the wrong instance will miss live events until it polls history or reconnects with a fallback.

Enterprise requirement:

- Publish terminal output events through a shared bus keyed by session ID.
- Define cursor semantics around durable byte offsets, not only local SSE event IDs.

### 7. File, Proxy, And Local LLM Streams Are Local Bridges

File reads, HTTP proxy, WebSocket proxy, and Bud-local LLM all use durable operation/stream rows plus local runtime objects:

- `fileRuntimeStreams` in [`../service/src/files/file-runtime.ts`](../service/src/files/file-runtime.ts)
- `proxyRuntimeStreams` in [`../service/src/proxy/proxy-runtime.ts`](../service/src/proxy/proxy-runtime.ts)
- `proxyWebSocketRuntimeSessions` in [`../service/src/proxy/proxy-ws-runtime.ts`](../service/src/proxy/proxy-ws-runtime.ts)
- `pendingOpenResults` in [`../service/src/llm/local-llm-data-plane.ts`](../service/src/llm/local-llm-data-plane.ts)
- `pendingFileResolves` in [`../service/src/files/file-resolve.ts`](../service/src/files/file-resolve.ts)

The active HTTP response or browser WebSocket is owned by one Node process. Another process cannot take over that response even if it can read the `bud_stream` row. That is normal for streaming gateways, but it means production needs explicit edge affinity or a dedicated gateway/broker role.

Enterprise requirement:

- A data-plane gateway architecture with either sticky routing by stream/session ID or a broker that can bridge browser streams to daemon streams independently of the API process.
- Stream ownership and cleanup leases.
- Per-tenant and per-Bud stream quotas measured across instances.
- Clear separation between durable operation audit state and live socket/stream ownership.

OSS default:

- In-process stream bridges are fine for a single-node server and make the self-hosted service useful.

### 8. Background Roles Are Implicit

Every `buildServer()` instance starts a `PushNotificationWorker` and a terminal idle monitor. The push worker is comparatively safe because it claims outbox rows with `FOR UPDATE SKIP LOCKED` in [`../service/src/notifications/worker.ts`](../service/src/notifications/worker.ts). The idle monitor updates and optionally closes terminal sessions from every process.

This is tolerable in one process. In production it should be explicit which replicas run background jobs.

Enterprise requirement:

- Process roles: API, daemon-gateway, agent-worker, stream-gateway, scheduler, push-worker.
- Leader election or advisory locks for singleton-ish jobs.
- Idempotent cleanup jobs and job ownership metrics.

### 9. Database Pools Multiply Per Instance

`service/` has a main Postgres pool and an auth pool. Default pool sizing is acceptable for one process but scales linearly with replicas. A deployment with API, worker, and gateway replicas can exhaust Postgres before application throughput is high.

Enterprise requirement:

- Pool sizing by process role.
- PgBouncer or managed connection pooling guidance.
- Backpressure when DB pool saturation occurs.

### 10. Gateway Drain Is Process-Local

`startGatewayDrain(...)` in [`../service/src/transport/gateway-drain.ts`](../service/src/transport/gateway-drain.ts) sets a module-level variable. It does not coordinate across instances, does not move traffic, and does not bind to durable `gateway_instance_id` placement.

Enterprise requirement:

- Per-gateway drain state in shared storage.
- Load balancer deregistration/drain integration.
- Bud reconnect hints or command routing around draining gateways.

### 11. Carrier Health Is Local

Data-plane carrier health is held on in-memory tracker objects and used for carrier selection. It is not aggregated across instances or persisted beyond session rows.

Enterprise requirement:

- Shared carrier health and stream-family availability.
- Placement-aware carrier selection.
- Metrics for degraded/unhealthy carriers.

## Tenancy And Enterprise Feature Gaps

### Tenant Model

The schema already includes `tenant_id` on many tables, but there is no tenant table, tenant resolver, org membership, or tenant-scoped SQL helper. Today the practical ownership boundary is `created_by_user_id`.

This is a good place to avoid a future split. The open source service can remain user-owned and single-tenant by default, while the core code should accept a tenant policy interface that enterprise can implement.

Needed:

- `TenantResolver` that maps viewer/request to tenant context.
- SQL helper conventions for `(tenant_id, created_by_user_id)` scoping.
- A clear inheritance rule from Bud to thread to terminal/proxy/file/message/run rows.
- Migration plan to backfill `tenant_id` if enterprise needs it non-null.

### Auth, SSO, And RBAC

Better Auth is fine for the OSS core. Enterprise will need SAML/OIDC policy controls, SCIM, org membership, teams, service accounts, API tokens, RBAC, audit visibility, and possibly shared Bud access.

Recommended boundary:

- Keep session normalization and ownership helpers in OSS.
- Define an `AuthPolicy` / `AuthorizationPolicy` interface around viewer, tenant, resource action, and owner stamping.
- Let enterprise provide SSO/RBAC implementations without replacing routes.

### Secrets And BYOK

Provider keys and APNs credentials are environment-level process config today. That works for self-hosting but not for multi-tenant production.

Needed:

- `SecretsProvider` interface for provider API keys, APNs keys, proxy edge secrets, and future daemon secrets.
- Tenant/user/provider key selection.
- Secret access audit events.
- Optional BYOK with key validation and rotation.
- A policy for which secrets can be sent to Bud and which must stay service-side.

### Usage Tracking And Quotas

The service records enough raw facts to build usage later: LLM usage, terminal bytes, stream operations, proxy/file request sizes, push attempts. It does not aggregate or enforce product-level quotas.

Enterprise should own:

- Token usage by tenant/user/thread/model/provider.
- Terminal output/input bytes.
- Proxy/file/local LLM stream bytes and duration.
- Active Bud/device/session counts.
- Notification sends.
- Quotas, budgets, rate limits, abuse controls, and billing exports.

The OSS core should expose a no-op `UsageRecorder` and call it from stable points rather than baking billing logic into route handlers.

### Audit And Compliance

`audit_event` is a useful foundation, especially for proxy/file/data-plane decisions. It is not yet a complete compliance log:

- Event taxonomy is uneven.
- Retention and export are not defined.
- Actor, tenant, resource, IP/user agent, and correlation IDs are not consistently present.
- Redaction policy is not centralized.

Enterprise should provide audit export, retention policy, SIEM integration, and compliance controls. OSS should keep the base audit table and append points where they are product-correct.

### Fleet Management

Device claim and daemon session basics are in core. Enterprise production likely needs:

- Daemon release channel and upgrade policy.
- Device posture and host metadata.
- Org-level Bud inventory.
- Shared Bud or team-based ACLs.
- Remote disconnect/revoke/rotate controls.
- Policy distribution to Buds.

This should be enterprise infrastructure around the same Bud identity/session tables, not a different daemon protocol.

## Recommended Open-Core Boundary

### Keep In OSS Core

Keep these under a permissive open source license:

- Fastify REST routes for single-user/self-hosted operation.
- Better Auth integration and normalized viewer helpers.
- Device claim and Bud enrollment.
- WebSocket daemon transport baseline.
- Optional gRPC carrier code if it is useful and not operationally proprietary.
- Thread/message/read-state APIs.
- Agent orchestration, tool contracts, transcript persistence, context compaction, and provider abstraction.
- Terminal session manager, output storage, and single-node live terminal behavior.
- File/proxy/proxied-site/local LLM single-node functionality.
- Postgres schema and Drizzle migrations for core tables.
- Protocol docs and codec.
- In-memory/default adapters for runtime state, event bus, daemon registry, and stream bridges.

This is enough to be a real self-hosted backend, not a demo that forces users into enterprise.

### Put In Enterprise

Put these behind the enterprise license:

- Distributed daemon connection registry and command broker.
- Horizontally scalable data-plane stream gateway.
- Agent turn queue, worker leasing, failover, and recovery.
- Distributed SSE/event bus/replay implementation.
- Distributed terminal request broker.
- Tenant/org/RBAC/SSO/SCIM.
- Usage metering, billing exports, budgets, quotas, and rate limits.
- Secrets proxy/BYOK and tenant-scoped provider credentials.
- Fleet management and device policy.
- Production drain, placement, rollout, scheduler, and background job orchestration.
- Enterprise observability, audit export, retention, and compliance controls.

### Avoid

Avoid these patterns:

- Do not create a second backend with copied route logic.
- Do not make open source `service/` intentionally unusable.
- Do not scatter `if enterprise` branches through route handlers for core behavior.
- Do not make durable database rows imply distributed correctness unless live routing actually supports it.
- Do not rely on a future relicensing event to protect commercial value. With MIT/Apache/BSD-style licensing, already-released code remains permissive for recipients.

## Adapter Interfaces To Introduce

The most important refactor is to name the process-local implementations as adapters, then let enterprise replace them.

Suggested interfaces:

- `DaemonConnectionRegistry`: current active Bud transports, connection generation, gateway instance, drain state.
- `DaemonCommandBus`: send a protocol frame to a Bud regardless of which process owns the socket.
- `DataPlaneStreamGateway`: create/own/route file, proxy, WebSocket proxy, and local LLM streams.
- `AgentTurnStore`: durable turn state, idempotency, cancellation, awaiting-user state.
- `AgentWorkQueue`: enqueue user-message turns and lease work to agent workers.
- `AgentEventBus`: publish/replay live agent events by thread and cursor.
- `TerminalEventBus`: publish/replay terminal output/readiness events by durable byte offset and event cursor.
- `TerminalRequestBroker`: send/observe requests with response routing and timeout ownership.
- `LeaseManager`: advisory locks, singleton jobs, cleanup ownership, and worker heartbeats.
- `TenantPolicy`: resolve tenant, owner, and allowed action.
- `SecretsProvider`: tenant/user/provider secret lookup and audit.
- `UsageRecorder`: meter LLM, terminal, proxy, file, local LLM, and notification usage.
- `QuotaLimiter`: enforce concurrent streams, request body limits, token budgets, and per-tenant rates.
- `AuditSink`: durable audit events plus optional enterprise export.

OSS implementations can be in-memory or direct-Postgres and selected by default. Enterprise implementations can use Redis, NATS, Kafka, Postgres advisory locks, cloud load-balancer affinity, or a dedicated gateway process.

## Phased Path

### Phase 0: Name The Modes

Document two modes without changing behavior:

- `single_node`: current open source/default mode.
- `distributed`: requires enterprise adapters and explicit process roles.

Add a startup warning if multiple replicas are detected without distributed adapters, if practical. At minimum, update deployment docs to say `service/` is single-instance by default.

### Phase 1: Extract Adapters Without Behavior Change

Wrap current module-level maps and managers behind interfaces:

- WebSocket/gRPC daemon trackers.
- Data-plane session tracker.
- Agent runtime state manager.
- Terminal event bus.
- Terminal request dispatcher.
- File/proxy/local LLM runtime stream registries.
- Background worker startup.

This creates the extension points before enterprise code exists.

### Phase 2: Make Agent Turns Durable

Introduce a durable active turn table or formalize the existing `run` concept if it exists outside current source paths. The route that accepts a user message should enqueue a turn, not run the agent directly.

Minimum durable state:

- `thread_id`
- `turn_id`
- `trigger_message_id`
- `status`
- `leased_by`
- `lease_expires_at`
- `cancel_requested_at`
- `awaiting_question_request_id`
- `owner_user_id`
- `tenant_id`

The single-node adapter can immediately lease and run inline. The enterprise adapter can distribute work.

### Phase 3: Distributed Agent Events

Persist or publish agent events through an adapter. Keep local in-memory buffers for OSS, but do not let route code assume local runtime state is the only event source.

Decide which events are durable product state versus ephemeral UX:

- Durable: final assistant messages, tool calls/results, question requests, final turn status, compaction start/done/failed.
- Ephemeral or bounded: draft text deltas, reasoning deltas, heartbeat.

### Phase 4: Distributed Daemon Routing

Use durable `device_session`/`transport_session` as the state model and add a live command bus. Each connected Bud should have:

- current gateway instance ID
- connection generation
- transport kind
- heartbeat freshness
- drain state
- supported stream families

`sendFrameToBud(...)` should target that registry rather than only a local map.

### Phase 5: Terminal Request Broker

Move observe/send request IDs into an addressable broker:

- requester instance/worker
- target Bud/session
- timeout/deadline
- status/result/error

Daemon results should be routed to the requester or written durably so any waiting worker can resume.

### Phase 6: Data-Plane Gateway Decision

Choose one enterprise strategy:

1. Sticky edge routing: all browser requests for a stream/session land on the process that owns the Bud data-plane carrier.
2. Dedicated stream gateway: a separate process owns browser and Bud streams, while API processes only create durable operations.
3. Brokered streams: a shared broker moves bytes between browser edge and daemon edge.

For Bud's use case, a dedicated stream gateway plus sticky routing by stream/session ID is probably the simplest production design. OSS keeps the in-process bridge.

### Phase 7: Tenant, Secrets, Usage, Quota

Add enterprise adapters and call sites once runtime distribution is named:

- Resolve tenant and owner for every route.
- Select provider secrets by tenant/model.
- Record usage at stable boundaries.
- Enforce quotas before expensive work starts.
- Emit audit events through `AuditSink`.

## Specific Findings By Subsystem

### `server.ts`

Finding: Composition is single-role. One Fastify server owns API, gateway, agent, terminal, stream runtime, idle monitor, push worker, and optional gRPC servers.

Impact: Horizontal scaling requires process-role separation or every replica will attempt every job.

Recommendation: Add role flags and dependency injection. Start background jobs only for configured roles.

### Auth And Ownership

Finding: Browser routes mostly scope by `created_by_user_id`. This is good core behavior. Tenant fields are present but not active.

Impact: Single-user and simple self-hosting are in good shape. Enterprise tenancy is not implemented.

Recommendation: Keep owner scoping in OSS. Add a tenant policy interface and avoid hardcoding org/RBAC into every route.

### Daemon Gateway

Finding: Active sessions are local maps. Durable session tables exist but are not enough to route live frames.

Impact: Multiple replicas will disagree about Bud online status and cannot route commands to Buds connected elsewhere.

Recommendation: Introduce a connection registry and command bus. Use durable session generation to prevent stale offline writes.

### Agent Runtime

Finding: Persistent transcript is strong, active execution is local.

Impact: Crash recovery, cancel, live SSE, and question continuations are not horizontally safe.

Recommendation: Add durable turn state and worker leases. Keep transcript/ledger/checkpoint code as core.

### Terminal Runtime

Finding: Output is durable; request waiters, readiness, event buffers, and pending command context are local.

Impact: History is scalable, live send/observe is not.

Recommendation: Broker terminal requests and publish output/readiness through a distributed event adapter.

### File/Proxy/Local LLM Runtime

Finding: Durable operation/stream records exist, but active streams are local Node objects.

Impact: Another instance can see that a stream exists but cannot serve or recover the browser response.

Recommendation: Treat stream serving as a gateway role. Enterprise should provide distributed edge/gateway infrastructure. OSS should keep in-process streams.

### Notifications

Finding: Push worker row claiming uses `FOR UPDATE SKIP LOCKED`, which is a good multi-worker primitive.

Impact: Multiple workers are safer here than in the rest of runtime, but role separation is still needed.

Recommendation: Keep the worker in OSS. Add process-role config and job metrics.

### LLM Providers

Finding: Providers are registered from global process config. LLM call usage is recorded, but there is no tenant/user provider-key selection or quota policy.

Impact: Self-hosting works with env vars. Enterprise needs secrets and model entitlement policy.

Recommendation: Add `SecretsProvider`, `ModelEntitlementPolicy`, `UsageRecorder`, and `QuotaLimiter`.

### Database

Finding: Schema already anticipates tenancy and durable operation/stream tracking, but many enterprise semantics are nullable or unused.

Impact: The schema is a good foundation. It should not be assumed to imply distributed runtime correctness.

Recommendation: Keep migrations in OSS. Add enterprise backfills/constraints only when tenant semantics are defined.

## License Strategy Notes

If the goal is a flexible open source license, Apache-2.0 is the strongest default candidate because it is permissive and includes an explicit patent grant. MIT/BSD-3-Clause are simpler and familiar, but they do not provide the same explicit patent structure.

The commercial protection should come from:

- clear product boundary,
- trademark control,
- hosted service/control-plane value,
- enterprise-only distributed infrastructure,
- support and operational tooling,
- cloud integrations,
- compliance features,
- secrets/usage/tenancy systems.

It should not come from withholding the minimum viable backend. If the OSS backend cannot run a real Bud, terminal, thread, and agent loop for a self-hosted user, the project will read as source-available bait rather than open source.

The Elastic lesson is not simply "avoid permissive licenses." It is that late boundary changes create market and community confusion. Draw the boundary now:

- Core server and protocol are open source.
- Horizontally scalable production control plane and enterprise operations are commercial.
- The enterprise layer composes the OSS core through documented adapters.

## Open Questions

- Is hosted Bud expected to support shared Buds and collaborative threads, or only one owner per Bud for the first enterprise version?
- Should `tenant_id` become non-null for enterprise rows, or remain nullable with `(tenant_id, created_by_user_id)` hybrid scoping?
- Which process roles should exist in the first production deployment: API, gateway, agent-worker, stream-gateway, scheduler, push-worker?
- Should gRPC remain in OSS as an optional carrier, or should only the WebSocket baseline be guaranteed in OSS?
- Should the first distributed event implementation use Postgres, Redis, NATS, or another broker?
- What exact commercial threat is being optimized against: public cloud resale of hosted Bud, enterprise account management, or operational HA?
- What contributor model is desired: DCO, CLA, or no inbound agreement beyond the outbound license?
- What trademark policy will govern hosted services that use the OSS core?

## Bottom Line

`service/` is a strong candidate for an open source core if it is explicitly positioned as a single-node service with honest limitations. The current architecture should not be scaled horizontally by adding replicas behind a load balancer. It needs distributed adapters for daemon routing, agent turns, terminal requests, event replay, and stream gateways.

The best path is to keep one backend codebase and split by adapter implementation and process role. The OSS distribution ships the single-node adapters. The enterprise distribution supplies distributed adapters, tenant/usage/secrets policy, production gateways, and operational tooling.
