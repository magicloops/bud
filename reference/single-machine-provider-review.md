For the **single-machine self-hosted service layer**, an always-on WebSocket is basically the right answer. On a plain VM, AWS/GCP/DigitalOcean/Hetzner do **not** charge you for “WebSocket connection-minutes.” You pay for:

```text
VM cost
+ public IP cost
+ disk/snapshots
+ outbound bandwidth
+ optional load balancer/proxy
```

An always-on HTTP/2 gRPC bidi stream is **not meaningfully cheaper** than an always-on WebSocket on a single VM. It may be better or worse ergonomically, but the cloud bill is almost identical unless you put a managed load balancer/proxy in front.

For self-hosted Bud, I would ship a **single-node mode** where the service binds directly to `:443` and supports:

```text
TCP 443:
  HTTPS API
  WebSocket control plane
  WebSocket data fallback
  browser front door

UDP 443:
  optional QUIC data plane

SQLite:
  local service state

Wildcard DNS:
  *.bud.example.com -> VM
```

No ALB, no GCP Load Balancer, no Kubernetes, no Redis, no Durable Objects. Just one binary or one Docker Compose file.

---

## WebSocket vs gRPC cost

For a direct VM:

| Transport             |         Cloud billing difference | Practical difference                                                                     |
| --------------------- | -------------------------------: | ---------------------------------------------------------------------------------------- |
| WebSocket over TLS    | No special per-connection charge | Easiest through proxies, easiest fallback, works almost everywhere                       |
| gRPC bidi over HTTP/2 |     No special per-stream charge | Better typed RPC semantics, native flow control, but more proxy/HTTP2 config sensitivity |
| QUIC                  | No special per-connection charge | Better multiplexed data plane, but UDP may be blocked                                    |
| WebSocket data tunnel | No special per-connection charge | TCP head-of-line blocking, but simplest fallback                                         |

So for the **control plane**, WebSocket is usually the lowest-friction option. If you want gRPC semantics, use protobuf envelopes over WebSocket and keep the transport swappable.

The exception is hosted/serverless edge infrastructure. Cloudflare Durable Objects WebSocket Hibernation has a pricing model that is specifically favorable for idle WebSocket control-plane connections: Durable Objects that are idle and hibernatable do not accrue duration charges, outgoing WebSocket messages and incoming protocol pings are not charged, and incoming WebSocket messages are billed at a 20:1 ratio for request billing. That cost advantage does **not** automatically carry over to gRPC. ([Cloudflare Docs][1])

---

## The single-machine cost model

For a self-hosted node, idle connections are mostly a **capacity** issue, not a **billing** issue.

A rough cost model:

```text
monthly_cost =
  vm_monthly_cost
+ public_ipv4_monthly_cost
+ disk_monthly_cost
+ outbound_gb * egress_price
+ optional_load_balancer_cost
```

Connection count affects:

```text
open file descriptors
kernel socket memory
TLS/session state
application buffers
event-loop pressure
heartbeat traffic
```

It does not usually create a separate line item unless you add a managed load balancer.

---

## Representative single-node provider costs

These are approximate “what does this feel like monthly?” numbers, not formal quotes. Region, architecture, OS image, disk, backups, and bandwidth can move them.

| Provider               |           Good self-host shape |               Approx idle control-plane cost | Notes                                                                                                                                                                                                                         |
| ---------------------- | -----------------------------: | -------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS EC2**            | t4g.small/t4g.medium direct VM |        ~$16–$30/mo before significant egress | Raw EC2 is flexible, but public IPv4 adds about $3.60/mo at $0.005/hr. AWS also gives 100 GB/month of regional data transfer out to the internet free across services except China/GovCloud. ([Amazon Web Services, Inc.][2]) |
| **AWS Lightsail**      |                  1–2 GB bundle | ~$5–$14/mo depending IPv6-only vs dual-stack | Best “simple AWS VPS” option. Lightsail bundles include SSD and transfer; AWS lists Linux/Unix IPv6-only bundles from $3.50/mo and 1 GB / 2 vCPU / 40 GB / 2 TB transfer at $5/mo. ([Amazon Web Services, Inc.][3])           |
| **GCP Compute Engine** |   e2-small/e2-medium direct VM |        ~$16–$30/mo before significant egress | Similar economics to EC2. GCP charges in-use external IPv4 for standard VMs at $0.005/hr; Standard Tier egress shows 200 GiB/month free, then $0.085/GiB in the listed tier. ([Google Cloud][4])                              |
| **DigitalOcean**       |           Basic 1–2 GB Droplet |                                    $6–$12/mo | Very good for self-host. DO lists 1 GB / 1 vCPU / 1 TB transfer at $6/mo and 2 GB / 1 vCPU / 2 TB transfer at $12/mo; overage is $0.01/GiB. ([DigitalOcean][5])                                                               |
| **Hetzner**            |      CX/CAX/CPX small cloud VM |                   ~$5–$10/mo in many regions | Likely the cheapest raw VM path. Hetzner’s April 2026 price table lists Germany/Finland CX23 at $4.99/mo and CAX11 at $5.49/mo; US CPX11 is $6.99/mo. ([Hetzner Docs][6])                                                     |
| **Fly.io**             |             shared-cpu machine |                       ~$6+/mo plus bandwidth | Good if you want simple deployment and regional placement. Fly lists shared-cpu-1x 1 GB at $5.92/mo and outbound transfer at $0.02/GB in North America/Europe. ([Fly.io][7])                                                  |

For the specific goal “one service node, daemons connect to it,” **DigitalOcean, Hetzner, Lightsail, or a raw EC2/GCP VM** are all reasonable. Hyperscalers become attractive when you need IAM/VPC/private networking/managed databases. VPS-style providers are often better when you want fixed-cost self-hosting.

---

## Where costs suddenly change: managed load balancers

If the daemon connects directly to one VM, WebSocket/gRPC idle cost is tiny. If you put AWS ALB in front, connection count becomes a billable dimension.

AWS ALB pricing includes Load Balancer Capacity Units. Each LCU includes 3,000 active connections per minute, 25 new connections/sec, 1 GB/hour processed bytes, and rule evaluations; the bill uses the largest dimension. AWS’s example pricing in us-east-1 uses $0.0225/hour for the ALB plus $0.008 per LCU-hour. ([Amazon Web Services, Inc.][8])

Approximate **AWS LB-only** monthly cost for idle long-lived connections, excluding VM and app bandwidth:

| Idle connections |    AWS ALB | AWS NLB TCP pass-through | GCP external LB forwarding rule |
| ---------------: | ---------: | -----------------------: | ------------------------------: |
|            1,000 |    ~$25/mo |                  ~$23/mo |       ~$18/mo + data processing |
|           10,000 |    ~$43/mo |                  ~$24/mo |       ~$18/mo + data processing |
|          100,000 |   ~$215/mo |                  ~$28/mo |       ~$18/mo + data processing |
|        1,000,000 | ~$1,943/mo |                  ~$67/mo |       ~$18/mo + data processing |

Those AWS numbers include the LB hourly charge and two AWS public IPv4 charges, using 30-day months. They are intended to show shape, not exact bills.

The important AWS detail: **NLB TCP pass-through is much cheaper for massive idle connection counts than ALB**, because AWS says each NLCU provides up to 100,000 active TCP connections/flows per minute, while TLS listeners have much lower active-flow capacity. If you terminate TLS inside your Bud process behind an NLB TCP listener, NLB can be cost-efficient at high idle connection counts. ([Amazon Web Services, Inc.][8])

GCP’s Cloud Load Balancing pricing page emphasizes forwarding rules and data processed rather than an active-WebSocket-connection LCU dimension; US forwarding rules are $0.025/hour for up to five forwarding rules. But GCP Application Load Balancers do have WebSocket lifetime/timeout behavior to design around: global external Application Load Balancers close active WebSocket connections after 24 hours, and idle WebSockets close after the backend service timeout. ([Google Cloud][4])

For self-hosted Bud, this means:

```text
Do not use a managed load balancer by default.
Bind the Bud service directly to the VM public IP.
Add LB support only as an advanced/HA deployment option.
```

---

## Heartbeats can cost more than the connection itself

The connection being open is usually cheap. The heartbeat pattern can become non-trivial.

If the server sends **100 bytes** to each daemon every **60 seconds**, approximate server egress is:

|   Daemons | Server egress/month |
| --------: | ------------------: |
|     1,000 |             ~4.3 GB |
|    10,000 |              ~43 GB |
|   100,000 |             ~432 GB |
| 1,000,000 |             ~4.3 TB |

That is why the control plane should be quiet:

```text
Prefer sparse application heartbeats.
Use TCP/WebSocket protocol keepalive where possible.
Do not send app-level “still alive?” messages every few seconds.
Let clients reconnect with jitter.
Treat presence as approximate.
```

For a single self-hosted user with tens or hundreds of daemons, this is negligible. For your hosted service with hundreds of thousands or millions of idle daemons, heartbeat design matters a lot.

---

## Is gRPC/H2 cheaper than WebSocket for always-on control?

Usually, no.

### Direct-to-VM

No meaningful difference. Both are long-lived encrypted connections. The provider sees bytes, packets, CPU, and memory—not “this is WebSocket” versus “this is gRPC.”

### AWS ALB

Not meaningfully cheaper. ALB prices active connections, new connections, processed bytes, and rule evaluations. A gRPC bidi stream and a WebSocket each consume a long-lived active client connection. HTTP/2 is useful if it reduces multiple connections into one, but your daemon control plane already wants one connection. ([Amazon Web Services, Inc.][8])

### AWS NLB TCP pass-through

Protocol does not matter much. WebSocket, gRPC, raw TLS, or QUIC-over-UDP are all mostly flow/byte accounting. NLB TCP pass-through is attractive because the active TCP connection capacity per NLCU is much higher than ALB’s L7 active-connection capacity. ([Amazon Web Services, Inc.][8])

### Cloudflare Durable Objects

WebSocket can be materially cheaper because WebSocket Hibernation is a specific Durable Objects feature. That pricing model does not translate to a normal gRPC bidi server. ([Cloudflare Docs][1])

---

## What I’d ship for self-hosted Bud

### `bud-service` single-node mode

One binary:

```bash
bud-service serve \
  --domain bud.example.com \
  --wildcard-domain '*.bud.example.com' \
  --db ./bud.sqlite \
  --tcp :443 \
  --udp :443 \
  --acme-email admin@example.com
```

Ports:

```text
TCP 443:
  /api/*
  /daemon/control        WebSocket control plane
  /daemon/data-ws        WebSocket data fallback
  wildcard app proxy     HTTPS browser front door

UDP 443:
  QUIC data tunnel, if available

TCP 80:
  optional ACME HTTP-01 and redirect
```

Storage:

```text
SQLite by default.
Postgres optional.
No Redis required.
No load balancer required.
```

DNS:

```text
A     bud.example.com        -> VM public IP
A     *.bud.example.com      -> VM public IP
AAAA  optional, if IPv6 works
```

This gives the user:

```text
install one server binary
open TCP/443 and optionally UDP/443
point DNS at it
install daemon binary locally
connect daemon to service URL
```

That is the right self-hosted shape.

---

## Provider recommendation for self-hosted users

### Best default for most users

Use **DigitalOcean, Hetzner, or Lightsail**.

They are predictable, cheap, and include meaningful transfer. For a self-hosted service layer, that matters more than cloud-native bells and whistles.

### Best AWS-native option

Use **Lightsail** first, not EC2, unless the user specifically needs EC2/VPC/IAM primitives.

Lightsail gives a VPS-like cost model with included transfer. EC2 is more flexible, but public IPv4, EBS, egress, CloudWatch, and optional LB choices make it easier to surprise users.

### Best raw AWS architecture

```text
Route 53 / DNS
  -> EC2 public IP
  -> bud-service on TCP/443 and UDP/443
```

No ALB.

If they need a load balancer later:

```text
NLB TCP pass-through
  -> EC2 bud-service terminates TLS
```

Use ALB only if they need L7 routing, managed cert termination, HTTP routing rules, or multi-service ingress.

### Best GCP architecture

```text
Cloud DNS / DNS
  -> Compute Engine VM external IP
  -> bud-service on TCP/443 and UDP/443
```

Avoid Cloud Run for the always-on daemon control plane; Cloud Run WebSockets are treated as long-running requests and are subject to request timeouts. ([Google Cloud Documentation][9])

---

## Practical limits on one machine

For self-hosting, the constraints are usually:

```text
ulimit / file descriptors
per-connection memory
kernel TCP settings
TLS buffer memory
application write buffers
heartbeat frequency
logs
bandwidth
```

A well-written Go or Rust service can handle thousands of mostly idle WebSocket connections on a small VM, and tens of thousands on a modest 4–8 GB VM with tuning. But do not promise a universal number: a naive Node/Express implementation, large per-socket buffers, verbose logging, or frequent heartbeats can reduce capacity dramatically.

For Bud’s single-node mode, expose a health/capacity endpoint:

```json
{
  "active_daemons": 3842,
  "active_control_sockets": 3842,
  "active_data_tunnels": 12,
  "open_fds": 8291,
  "rss_mb": 742,
  "outbound_gb_this_month": 51.2
}
```

And document recommended system settings:

```text
ulimit -n 1048576
systemd LimitNOFILE=1048576
reasonable TCP keepalive settings
bounded per-connection buffers
jittered reconnects
```

---

## The key product decision

I would make **WebSocket the default self-hosted control transport**.

Reasons:

```text
- Cheapest/easiest direct-to-VM path.
- Works with almost every reverse proxy and firewall.
- Maps cleanly to Cloudflare DO hibernation in hosted mode.
- Easier for users who deploy on random VPS/PaaS environments.
- You can still send protobuf envelopes over it.
```

Then make gRPC optional:

```text
bud-service --enable-grpc
```

Useful for users who prefer typed RPC and have clean HTTP/2 infrastructure, but not required.

For data plane:

```text
1. QUIC over UDP/443 when available.
2. HTTP/2 or TLS stream fallback.
3. WebSocket tunnel fallback.
```

The self-hosted service does not need the same horizontally scalable architecture as your hosted production service. It needs a clean degradation path.

---

## My concrete recommendation

For self-hosted Bud, ship this:

```text
Bud Single Node
  - WebSocket control plane
  - QUIC data plane
  - WebSocket data fallback
  - SQLite state
  - built-in TLS/ACME
  - wildcard-domain proxy
  - direct VM deployment
```

Recommended provider docs:

```text
Tiny/personal:
  Hetzner CX/CAX, DigitalOcean $6 Droplet, Lightsail $5–$10 bundle

AWS-native:
  Lightsail for fixed cost
  EC2 direct public IP for flexibility
  NLB TCP pass-through only when they outgrow direct VM

GCP-native:
  Compute Engine direct public IP
  avoid Cloud Run for long-lived daemon sockets
  use load balancer only when they need multi-node/HA
```

For your hosted production system, Cloudflare Durable Object WebSocket Hibernation still makes sense. For self-hosted users, a plain always-on WebSocket to a single VM is simpler, cheap enough, and operationally much easier than trying to replicate the full hosted architecture.

[1]: https://developers.cloudflare.com/durable-objects/platform/pricing/ "Pricing · Cloudflare Durable Objects docs"
[2]: https://aws.amazon.com/vpc/pricing/?utm_source=chatgpt.com "Amazon VPC Pricing"
[3]: https://aws.amazon.com/lightsail/pricing/?utm_source=chatgpt.com "Amazon Lightsail Pricing"
[4]: https://cloud.google.com/vpc/network-pricing "Network pricing | Google Cloud"
[5]: https://www.digitalocean.com/pricing/droplets "Droplet Pricing | DigitalOcean"
[6]: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment "Hetzner Price Adjustment - Hetzner Docs"
[7]: https://fly.io/docs/about/pricing/ "Fly.io Resource Pricing · Fly Docs"
[8]: https://aws.amazon.com/elasticloadbalancing/pricing/ "Elastic Load Balancing pricing"
[9]: https://docs.cloud.google.com/run/docs/triggering/websockets?utm_source=chatgpt.com "Using WebSockets | Cloud Run"

