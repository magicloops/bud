> Do we standardize on Buf + Connect for the service, with Rust using tonic/prost from the same .proto, or do we use traditional @grpc/grpc-js on the Node service? What are the downsides to Buf + Connect? 

> **Update after Phase 1.5 spike (2026-04-26): Use Buf for schema/tooling, Rust `tonic` / `prost` for the daemon, and `@grpc/grpc-js` for the Node daemon gateway. Keep Connect-ES for non-daemon APIs where useful.**

The decisive issue was not generic Connect status mapping. Connect-ES mapped an immediate `ConnectError(Code.DeadlineExceeded)` to tonic correctly. The blocker was the native gRPC bidi client-deadline path: when tonic's deadline expired, the Connect handler observed `ctx.signal.reason` as `Code.Canceled` from HTTP/2 `CANCEL`, and tonic received cancellation / transport timeout rather than reliable `DeadlineExceeded`. That is not a good fit for Bud's durable daemon operation classification.

The grpc-js comparison passed the clean interop matrix after fixing spike lifecycle bugs around status emission, pending async writes, and stream close ordering. See [../plan/network-upgrade/phase-1.5-runtime-decision.md](../plan/network-upgrade/phase-1.5-runtime-decision.md) for the accepted decision.

> **Standardize on Buf for schema/tooling. Use Connect on Node only if the daemon-facing service is served over native gRPC on HTTP/2 and validated against Rust `tonic`. Otherwise use `@grpc/grpc-js` for the daemon gateway and Connect for less critical/frontend-adjacent APIs.**

More concretely:

```text
Yes:
  Buf as the source-of-truth protobuf toolchain.

Yes:
  Rust daemon uses tonic/prost generated from the same .proto.

Maybe:
  Node daemon gateway implemented with Connect-ES / connect-node.

But:
  The daemon-facing wire protocol should be native gRPC over HTTP/2,
  not Connect-over-HTTP/1.1.

Fallback:
  If Connect introduces friction around long-lived bidi streams,
  use @grpc/grpc-js for the daemon gateway.
```

The distinction matters because **Connect the ecosystem** and **Connect the wire protocol** are not the same thing. Connect’s Node runtime can serve multiple protocols. With HTTP/2, Connect’s Node server can serve Connect, gRPC, and gRPC-Web with all RPC shapes, including bidirectional streaming; over HTTP/1.1, gRPC and bidirectional streaming are not supported. ([Protobuf RPC that works][1])

For Bud, the daemon path should remain:

```text
Rust daemon tonic/prost
  → native gRPC over HTTP/2
  → Node gateway
```

Even if the Node gateway is implemented using Connect.

---

# Recommended choice

## Use Buf, regardless

Buf is an easy yes.

Use it for:

```text
proto formatting
proto linting
breaking-change detection
code generation
module/dependency management
CI enforcement
optional generated SDK distribution
```

Buf’s `buf generate` is positioned as a replacement for direct `protoc` codegen, and `buf breaking` compares a schema against a prior version to report changes that would break clients, servers, or generated code. ([Buf][2])

That fits Bud extremely well because your protocol needs long-lived compatibility across:

```text
old daemons
new backend
new daemons
old self-hosted backend
WebSocket fallback
HTTP/2 fallback
QUIC fast path
```

I would make Buf non-negotiable.

---

# The real decision: Connect Node vs `@grpc/grpc-js`

## Option A: Buf + Connect Node

This means:

```text
.proto files:
  canonical source of truth

TypeScript:
  generated with Buf / Protobuf-ES / Connect

Node service:
  implemented with @connectrpc/connect-node or Fastify plugin

Rust daemon:
  generated with tonic/prost from the same .proto

Wire protocol daemon↔backend:
  native gRPC over HTTP/2
```

This is viable.

Connect’s protocol supports unary, client-streaming, server-streaming, and bidirectional streaming with protobuf or JSON payloads, but bidirectional streaming requires HTTP/2. ([Protobuf RPC that works][3]) Connect’s Node transport uses Node’s built-in `http`, `https`, and `http2` modules, and with HTTP/2 can call all RPC types using Connect, gRPC, or gRPC-Web protocols. ([Protobuf RPC that works][4])

So the compatibility story can be:

```text
Rust daemon:
  tonic speaks gRPC

Node Connect gateway:
  serves native gRPC over HTTP/2

Internal tools:
  may use Connect protocol

Browser tooling:
  may use Connect/gRPC-Web if useful later
```

That is attractive.

## Option B: Buf + `@grpc/grpc-js`

This means:

```text
.proto files:
  canonical source of truth

TypeScript:
  generated using Buf-compatible plugins, ts-proto, or grpc tooling

Node daemon gateway:
  implemented with @grpc/grpc-js

Rust daemon:
  tonic/prost

Wire protocol daemon↔backend:
  native gRPC over HTTP/2 only
```

This is the conservative choice for the daemon gateway.

`@grpc/grpc-js` is the official pure JavaScript gRPC implementation for Node; the grpc-node repo describes it as implementing core gRPC functionality without a C++ addon and working on current Node platforms. ([GitHub][5]) gRPC itself is built around protobuf service definitions, so this is the most direct match to Rust `tonic`. ([gRPC][6])

---

# My suggested split for Bud

I would probably choose this:

```text
Schema/tooling:
  Buf

Daemon gateway:
  native gRPC semantics

Node implementation:
  start with Connect only if you commit to serving native gRPC over HTTP/2
  and run tonic interoperability tests in CI

Fallback plan:
  use @grpc/grpc-js for daemon gateway if Connect causes stream/proxy friction

Other backend APIs:
  Connect is a very good fit
```

In short:

> **Buf: yes. Connect: likely yes for service ergonomics, but not at the cost of native gRPC daemon interoperability.**

I would not make the daemon depend on the Connect protocol. I would make it depend on **gRPC over HTTP/2**.

---

# Why Connect is attractive

## 1. Better TypeScript ergonomics

Connect-ES / Protobuf-ES gives you a more modern TypeScript experience than traditional Node gRPC tooling.

Protobuf-ES generates plain TypeScript, uses ECMAScript modules by default, and works across browsers, Node.js, Deno, and Bun. ([GitHub][7]) That is useful if you ever want shared protocol types across backend, CLI, tests, web, or generated SDKs.

## 2. One schema can serve multiple protocol consumers

Connect Node can serve:

```text
Connect protocol
native gRPC
gRPC-Web
```

on the same service definitions, assuming the correct HTTP version and server adapter. ([Protobuf RPC that works][1])

That is useful for Bud because you may eventually want:

```text
Rust daemon:
  native gRPC

Node workers:
  Connect or gRPC

Browser/debug clients:
  Connect or gRPC-Web

CLI/testing tools:
  Connect JSON or binary
```

## 3. Easier debugging for unary APIs

Connect unary RPCs can be more HTTP-tool-friendly than native gRPC. The Connect protocol supports JSON payloads and unary calls over HTTP/1.1, while bidirectional streaming still requires HTTP/2. ([Protobuf RPC that works][3])

That is nice for admin/debug/internal APIs.

## 4. Buf ecosystem is coherent

Buf + Protobuf-ES + Connect is a coherent stack. Buf also supports generated SDK workflows, where schemas pushed to the Buf Schema Registry can produce installable SDKs for multiple languages. ([Buf][8])

For an open-source project, that can make downstream integrations cleaner.

---

# Downsides of Buf + Connect

## 1. Connect is not the universal default runtime

Native gRPC is still the default mental model for many infra teams, observability tools, examples, service meshes, and language ecosystems.

Connect can serve native gRPC, but once you choose Connect you are adopting:

```text
Connect runtime
Connect interceptors
Connect error handling conventions
Connect server adapters
Protobuf-ES message model
Buf codegen conventions
```

That is not bad, but it is a stack choice.

For Bud’s daemon tunnel, where Rust `tonic` interop and long-lived bidi streams are core, I would avoid anything that makes the daemon path feel “Connect-specific.”

## 2. HTTP/2 support becomes a hard requirement for your critical streams

Connect’s own docs are explicit: Node/Fastify can serve all RPC types over HTTP/2, but over HTTP/1.1 gRPC and bidirectional streaming are not supported. Express and Next.js adapters cannot support native gRPC/bidi because they do not support Node’s `http2` module in that path. ([Protobuf RPC that works][1])

That means for Bud you must be disciplined:

```text
Do not run daemon gateway through Express.
Do not run daemon gateway through Next.js API routes.
Do not accidentally deploy it as HTTP/1.1-only.
Do not let a proxy downgrade or buffer streaming traffic.
```

Use one of:

```text
Node http2 server
Fastify with HTTP/2
Envoy / HAProxy / TCP LB in front
```

## 3. Streaming proxy support can be tricky

Connect’s FAQ says unary Connect RPCs can be proxied through NGINX because they do not require end-to-end HTTP/2, but streaming RPCs typically require end-to-end HTTP/2; it recommends Envoy, Apache, or TCP-level load balancers like HAProxy for the full Connect protocol. ([Protobuf RPC that works][9])

Bud’s daemon path is streaming-heavy:

```text
control stream
attach stream pool
terminal streams
file streams
proxy streams
```

So you should assume “normal web framework + normal reverse proxy” is not enough. This is also true for native gRPC, but Connect can make it easier to accidentally deploy unary things through HTTP/1.1 while forgetting that bidi needs end-to-end HTTP/2.

## 4. Rust will not use Connect protocol through `tonic`

Rust `tonic` speaks gRPC over HTTP/2. It does not become a Connect client just because the `.proto` files are shared.

So the working model is:

```text
Node Connect server:
  enable native gRPC protocol

Rust tonic daemon:
  calls native gRPC endpoint
```

Not:

```text
Rust tonic daemon:
  calls Connect protocol endpoint
```

That is fine, but the distinction should be explicit in the design docs.

## 5. Connect-ES has had meaningful breaking changes

Connect-ES 2.0 was announced as generally available in November 2024, but it was a major version bump with breaking changes; Buf’s post says it required Node.js 18+ and TypeScript 4.9.6+, changed generated-code APIs, and included migration tooling. ([Buf][10])

That does not mean “avoid it.” It means:

```text
pin versions
commit generated code or lock generated SDK versions
add protocol conformance tests
do not let generator upgrades happen casually
```

For a daemon protocol, generated-code churn is operationally expensive.

## 6. Buf can become a platform dependency if you over-adopt BSR

Buf CLI is easy to justify. Buf Schema Registry and remote plugins are optional.

The BSR gives useful features: versioned modules, dependency management, documentation, remote plugins, and generated SDKs. ([Buf][11]) But for an open-source project, you should avoid making public builds depend on a hosted proprietary workflow unless you intend that.

Recommended posture:

```text
Use Buf CLI locally and in CI.
Keep .proto files in the repo.
Keep buf.yaml and buf.gen.yaml in the repo.
Prefer pinned local or reproducible plugin versions for core builds.
Use BSR optionally for hosted/internal distribution.
Do not require BSR for self-hosters or contributors.
```

## 7. Connect may be slightly less direct for low-level gRPC tuning

For the daemon gateway, you may eventually care about:

```text
keepalive tuning
HTTP/2 flow-control windows
max concurrent streams
max message size
backpressure behavior
stream cancellation behavior
metadata/trailers
load balancer behavior
connection draining
debugging half-open streams
```

`@grpc/grpc-js` is closer to “plain Node gRPC.” Connect may still expose what you need, but there is another abstraction layer. For boring unary APIs, that abstraction is a benefit. For Bud’s daemon tunnel, it is something to validate.

---

# Downsides of `@grpc/grpc-js`

`@grpc/grpc-js` is not automatically better.

## 1. TypeScript ergonomics are worse

Traditional Node gRPC tends to be less pleasant than Connect/Protobuf-ES. You often end up choosing between dynamic proto loading, generated JS with awkward typings, or third-party generation setups.

For a protocol-heavy product like Bud, that matters.

## 2. Browser/debug friendliness is worse

Native gRPC is not naturally browser-friendly. If you later want browser-callable RPCs, you need gRPC-Web, Connect, a proxy, or separate HTTP APIs.

You already have HTTP/SSE for web/mobile, so this may not matter for the daemon gateway.

## 3. More “old-school gRPC” operational surface

Native gRPC gives you trailers, gRPC-specific status mapping, and more infrastructure expectations. This is fine if your infra is gRPC-ready, but less pleasant for ad hoc debugging.

## 4. You may still use Buf anyway

Choosing `@grpc/grpc-js` does not remove the need for schema governance. You still want Buf for linting, breaking changes, generation, and CI.

---

# Decision matrix

| Question                         | Buf + Connect Node                    | Buf + `@grpc/grpc-js`           |
| -------------------------------- | ------------------------------------- | ------------------------------- |
| Schema governance                | Excellent                             | Excellent if still using Buf    |
| TypeScript ergonomics            | Better                                | Usually worse                   |
| Rust `tonic` interop             | Good if serving native gRPC over H2   | Direct                          |
| Long-lived bidi confidence       | Good, but validate carefully          | Most conservative               |
| Browser/debug friendliness       | Better                                | Worse                           |
| HTTP/1.1 unary support           | Better                                | Not native gRPC                 |
| Critical H2/bidi deployment risk | Easy to misconfigure adapters/proxies | Still present, but more obvious |
| Ecosystem familiarity            | Growing                               | Traditional gRPC path           |
| Fit for daemon gateway           | Good with safeguards                  | Very good                       |
| Fit for public/backend APIs      | Very good                             | Less ergonomic                  |

---

# What I would put in the spec

## Recommended standard

```text
Bud uses Protocol Buffers as the canonical protocol schema.

Bud uses Buf for:
  linting
  formatting
  breaking-change detection
  code generation
  CI enforcement

Bud daemon uses:
  Rust tonic/prost generated from the canonical .proto files

Bud daemon gateway exposes:
  native gRPC over HTTP/2

The Node implementation may use:
  Connect Node, if native gRPC over HTTP/2 is enabled and validated
  or @grpc/grpc-js, if Connect creates friction for long-lived streams

The Connect protocol may be used for:
  internal tools
  admin APIs
  frontend-adjacent RPCs
  local debugging
  non-daemon unary/server-streaming APIs

The daemon control/data fallback protocol must not depend on:
  Connect-over-HTTP/1.1
  Express/Next.js adapters
  gRPC-Web
```

## Interop test requirement

Before committing to Connect Node for the daemon gateway, run this spike:

```text
Rust tonic daemon client
  ↔ Node Connect server exposing native gRPC over HTTP/2

Test:
  long-lived bidi control stream
  server directive while client is streaming heartbeats
  client cancellation
  server cancellation
  deadline exceeded
  max message size
  metadata propagation
  status/error details
  gateway drain
  reconnect under load
  1000+ stream-open/close cycles
  concurrent attach streams
  slow receiver backpressure
  proxy/file streaming fallback
```

If that passes cleanly, Connect Node is a reasonable choice.

If it gets weird, use `@grpc/grpc-js` for the daemon gateway and keep Connect elsewhere.

---

# Practical recommendation

I would adopt this as the engineering default:

```text
1. Buf everywhere for schemas.

2. Rust daemon:
   tonic/prost.

3. Node daemon gateway:
   start with Connect Node only if you can serve native gRPC over HTTP/2
   using Node http2/Fastify/appropriate infra.

4. Keep @grpc/grpc-js as the fallback implementation for the daemon gateway,
   not as the fallback protocol.

5. Use Connect freely for non-daemon APIs where browser/debug friendliness matters.

6. Do not let the daemon protocol depend on Connect-over-HTTP/1.1.
```

My bias:

> **Use Buf + Connect as the platform direction, but define the daemon contract as native gRPC over HTTP/2.**

That gives you Connect’s ergonomics without making the Rust daemon or the most critical networking path depend on a less universal wire protocol.

[1]: https://connectrpc.com/docs/node/server-plugins/ "Server plugins | Connect"
[2]: https://buf.build/docs/generate/tutorial/ "Quickstart - Buf Docs"
[3]: https://connectrpc.com/docs/protocol/ "Connect Protocol Reference | Connect"
[4]: https://connectrpc.com/docs/node/using-clients/ "Using clients | Connect"
[5]: https://github.com/grpc/grpc-node "GitHub - grpc/grpc-node: gRPC for Node.js · GitHub"
[6]: https://grpc.io/docs/what-is-grpc/core-concepts/ "Core concepts, architecture and lifecycle | gRPC"
[7]: https://github.com/bufbuild/protobuf-es "GitHub - bufbuild/protobuf-es: Protocol Buffers for ECMAScript. The only JavaScript Protobuf library that is fully-compliant with Protobuf conformance tests. · GitHub"
[8]: https://buf.build/docs/bsr/generated-sdks/ "Consuming generated SDKs - Buf Docs"
[9]: https://connectrpc.com/docs/faq/ "FAQs | Connect"
[10]: https://buf.build/blog/connect-es-v2 "Connect RPC for JavaScript: Connect-ES 2.0 is now generally available"
[11]: https://buf.build/docs/bsr/ "Introduction - Buf Docs"


> How does QUIC play into this decision?

QUIC changes the decision in one major way:

> **Do not let either Connect or `@grpc/grpc-js` become the canonical Bud protocol. Let Buf/protobuf define the protocol; let Connect or `@grpc/grpc-js` implement the HTTP/2 gRPC control/fallback service; let QUIC carry the same protobuf envelopes on the fast data path.**

So the stack should be:

```text
Buf / .proto:
  canonical protocol and schema

HTTP/2 gRPC:
  control plane
  fallback data plane
  implemented in Node via Connect or @grpc/grpc-js

QUIC:
  preferred data plane
  implemented as Bud-over-QUIC or HTTP/3/WebTransport-like transport
  uses the same protobuf messages/envelopes
  does not depend on Connect or @grpc/grpc-js

WebSocket:
  compatibility fallback
  same protobuf envelopes
```

In other words: **QUIC makes Buf more important, but makes the Connect vs `@grpc/grpc-js` choice less central.**

---

# The key distinction

There are two separate questions:

```text
1. What is our schema/protocol source of truth?
   → Buf + protobuf.

2. What runtime do we use for HTTP/2 gRPC services in Node?
   → Connect Node or @grpc/grpc-js.

3. What runtime do we use for QUIC data transport?
   → likely not Connect Node or @grpc/grpc-js directly.
```

Connect and `@grpc/grpc-js` are both mainly answers to question 2. QUIC is question 3.

---

# QUIC pushes you toward an envelope-first design

If Bud only had HTTP/2 gRPC, it would be tempting to make the `.proto` service methods the whole product protocol:

```proto
service BudData {
  rpc ReadFile(ReadFileRequest) returns (stream FileChunk);
  rpc OpenTerminal(stream TerminalFrame) returns (stream TerminalFrame);
  rpc ProxyHttp(stream ProxyFrame) returns (stream ProxyFrame);
}
```

That is fine for HTTP/2 fallback, but QUIC wants something more flexible.

For QUIC, you likely want:

```text
one QUIC connection per daemon data session
many QUIC streams
each QUIC stream carries BudEnvelope / BudFrame protobuf messages
each stream maps to a logical Bud stream_id
```

So the canonical data-plane shape should be closer to:

```proto
message BudEnvelope {
  string protocol_version = 1;
  string device_id = 2;
  string device_session_id = 3;
  string transport_session_id = 4;
  string stream_id = 5;
  TrafficClass traffic_class = 6;
  uint64 sequence = 7;
  bytes payload = 8;
  string payload_type = 9;
}
```

Then specific payloads can be:

```proto
message OpenLocalhostProxyStream { ... }
message HttpRequestHeaders { ... }
message HttpResponseHeaders { ... }
message DataChunk { ... }
message StreamCredit { ... }
message StreamReset { ... }
message FileReadRequest { ... }
message FileReadChunk { ... }
message TerminalFrame { ... }
```

HTTP/2 gRPC can wrap those same messages in RPCs. QUIC can carry them directly. WebSocket can carry them directly.

That is the part QUIC really changes.

---

# Connect vs `@grpc/grpc-js` with QUIC in the picture

## Buf

QUIC makes Buf an even stronger yes.

Buf gives you the schema governance you need across:

```text
Rust daemon
Node control gateway
QUIC data gateway
HTTP/2 fallback
WebSocket fallback
tests
SDKs
self-hosted deployments
old daemons
new backend
```

The canonical contract should be the `.proto` files, not a Node runtime or a gRPC service implementation.

## Connect

Connect is still attractive for the HTTP/2 side, especially because it can serve native gRPC over HTTP/2 while giving you better TypeScript ergonomics and optional Connect/gRPC-Web support. Connect’s own docs say the protocol supports unary, client-streaming, server-streaming, and bidirectional-streaming RPCs with protobuf or JSON payloads, but bidirectional streaming requires HTTP/2. ([Protobuf RPC that works][1])

For Node specifically, Connect’s docs say Node can serve Connect, gRPC, and gRPC-Web with all RPC types over HTTP/2, while HTTP/1.1 does not support gRPC or bidirectional streaming. ([Protobuf RPC that works][2])

That means Connect is fine for:

```text
mandatory HTTP/2 control plane
HTTP/2 fallback data streams
internal admin/debug APIs
possibly frontend-adjacent APIs
```

But Connect should **not** be treated as the QUIC implementation.

## `@grpc/grpc-js`

`@grpc/grpc-js` is still the conservative native-gRPC answer for the Node HTTP/2 gateway. It may be preferable if the daemon-facing control stream has tricky long-lived bidi behavior and you want the most traditional Node gRPC runtime.

But `@grpc/grpc-js` also does not solve QUIC.

So QUIC reduces the architectural importance of this choice:

```text
Connect vs @grpc/grpc-js:
  important for HTTP/2 ergonomics and interop

Buf/envelope design:
  important for the entire Bud networking architecture

QUIC runtime:
  separate implementation decision
```

---

# Do not make QUIC “gRPC-over-HTTP/3” the default assumption

There are three possible QUIC designs.

## Option A: gRPC-over-HTTP/3

This is conceptually clean:

```text
same gRPC services
HTTP/2 fallback
HTTP/3 fast path
```

But I would not make this the default bet unless your exact language/runtime/proxy stack has mature support for it.

Bud needs daemon-initiated reverse streams, backend-assigned work, localhost proxying, byte-range reads, terminal interactivity, and health-scored fallback. Trying to express all of that as normal gRPC-over-H3 may constrain you more than help.

## Option B: Connect-over-HTTP/3

Connect’s protocol says it is specified over HTTP and does not depend on framing details specific to a particular HTTP version. ([Protobuf RPC that works][1])

That is promising in theory. But the practical Node server documentation you would rely on for Bud talks about HTTP/2 and HTTP/1.1 support, not a production Node HTTP/3/QUIC server path. ([Protobuf RPC that works][2])

So I would not make Connect-over-H3 the core QUIC design today.

## Option C: Bud-over-QUIC

This is what I would recommend.

```text
QUIC connection:
  authenticated and bound to HTTP/2 control session

QUIC streams:
  carry BudEnvelope / BudFrame protobuf messages

Control:
  still HTTP/2 gRPC

Data:
  QUIC preferred
  HTTP/2 fallback
  WebSocket compatibility fallback
```

This lets you use QUIC where it is strongest: independent streams, low-latency connection establishment, stream-level flow control, and avoiding TCP head-of-line blocking between unrelated data streams. HTTP/3’s RFC describes QUIC’s desirable HTTP transport properties as stream multiplexing, per-stream flow control, and low-latency connection establishment; it also notes that independent streams allow one blocked/loss-affected stream not to prevent progress on other streams. ([QUIC][3])

That maps directly to Bud’s use case:

```text
terminal remains interactive
video range read continues
parallel webview assets load independently
large file transfer does not block control
```

---

# Node runtime implication

This is the biggest practical impact.

If the backend service is Node, then Connect vs `@grpc/grpc-js` is an HTTP/2 decision. But QUIC may push the **data gateway** out of Node, at least initially.

As of the current Node docs, QUIC support in Node v25 is behind `--experimental-quic` and marked “Active development.” ([Node.js][4]) Node’s release guidance says production applications should use Active LTS or Maintenance LTS releases; Node v25 is Current, while v24/v22/v20 are LTS. ([Node.js][5])

So I would not build a production-critical QUIC gateway on experimental Node core QUIC.

A better production shape is:

```text
Node:
  API service
  command store integration
  HTTP/2 gRPC control gateway
  HTTP/2 fallback data gateway
  SSE/web/mobile-facing APIs

Rust or Go sidecar/service:
  QUIC data gateway
  stream scheduler
  proxy/file/video fast path
```

Since your daemon is Rust with `tonic/prost`, a Rust QUIC data gateway is a natural fit because it can reuse the same protobuf message definitions and likely share some protocol code with the daemon.

The backend can still be “a Node service” from the product/API perspective. The QUIC gateway can be a separate service behind the session registry.

---

# How I would decide now

I would update the recommendation to:

```text
Standardize on Buf.

Use Connect Node for HTTP/2 gRPC only if:
  it serves native gRPC over HTTP/2
  Rust tonic interop passes
  long-lived bidi tests pass
  your deployment path is not Express/Next/HTTP1-only

Use @grpc/grpc-js if:
  Connect introduces friction on daemon-facing bidi streams
  you want the most conservative native gRPC runtime for control

Do not use either as the QUIC data runtime.

Implement QUIC as a separate Bud-over-QUIC data transport
using the same protobuf envelopes.
```

My bias would be:

```text
Buf:
  yes, mandatory

Node HTTP/2 control:
  Connect is fine if interop tests pass
  @grpc/grpc-js is the fallback if not

QUIC data plane:
  separate Rust/Go service
  same protobuf messages
  not gRPC-over-H3 as the first implementation
```

---

# The design rule to add to the spec

I would add this explicitly:

> **gRPC service definitions are the HTTP/2 control/fallback API. BudEnvelope and Bud stream messages are the transport-independent protocol. QUIC carries Bud envelopes directly and must not depend on Connect or Node gRPC runtime semantics.**

That prevents three bad outcomes:

```text
1. QUIC gets blocked on Connect/gRPC-over-H3 maturity.

2. WebSocket fallback becomes a separate protocol.

3. HTTP/2 gRPC method semantics leak into places where QUIC stream semantics would be better.
```

---

# Practical architecture

```text
              ┌──────────────────────────┐
              │ Node API / Control Plane │
              │                          │
Web/Mobile ──▶│ HTTP + SSE               │
              │ Connect or grpc-js H2    │
              └──────────┬───────────────┘
                         │
                         │ HTTP/2 gRPC control
                         │
                  ┌──────▼──────┐
                  │ Bud Daemon  │
                  └──────┬──────┘
                         │
                         │ QUIC preferred data
                         │ HTTP/2 fallback data
                         │ WebSocket final fallback
                         │
              ┌──────────▼───────────┐
              │ QUIC Data Gateway    │
              │ likely Rust/Go       │
              │ BudEnvelope streams  │
              └──────────────────────┘
```

Control-plane calls remain service-shaped:

```proto
service BudControl {
  rpc Connect(stream AgentControlEvent)
      returns (stream ServerControlDirective);
}
```

Data-plane messages remain envelope-shaped:

```proto
message BudDataFrame {
  string stream_id = 1;
  uint64 sequence = 2;

  oneof payload {
    OpenStream open = 10;
    DataChunk data = 11;
    StreamCredit credit = 12;
    StreamReset reset = 13;
    HalfClose half_close = 14;
    FileReadRequest file_read = 20;
    HttpRequestHeaders http_req = 30;
    HttpResponseHeaders http_res = 31;
    TerminalInput terminal_in = 40;
    TerminalOutput terminal_out = 41;
  }
}
```

HTTP/2 fallback can expose:

```proto
service BudDataFallback {
  rpc Attach(stream BudDataFrame) returns (stream BudDataFrame);
}
```

QUIC can carry the same `BudDataFrame` on each QUIC stream.

WebSocket can carry the same `BudDataFrame` with degraded limits.

---

# Bottom line

QUIC does **not** mean “don’t use Connect.” It means:

```text
Use Buf as the canonical protocol system.

Use Connect or @grpc/grpc-js for the HTTP/2 gRPC control/fallback service.

Do not couple the Bud data protocol to either Node runtime.

Implement QUIC as a first-class Bud transport that carries the same protobuf envelopes directly.

Strongly consider a Rust/Go QUIC data gateway rather than production Node QUIC today.
```

So the answer is:

> **QUIC makes the runtime decision less about Connect vs `@grpc/grpc-js`, and more about making Bud protocol-first instead of RPC-runtime-first.**

[1]: https://connectrpc.com/docs/protocol/ "Connect Protocol Reference | Connect"
[2]: https://connectrpc.com/docs/node/server-plugins/ "Server plugins | Connect"
[3]: https://quicwg.org/base-drafts/rfc9114.html "RFC 9114: HTTP/3"
[4]: https://nodejs.org/api/cli.html "Command-line API | Node.js v25.9.0 Documentation"
[5]: https://nodejs.org/en/about/previous-releases "Node.js — Node.js Releases"
