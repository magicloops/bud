# Future phase 5: evaluate WebRTC browser media

Status: scoped, not implemented; screenshots remain the default.

## Objective and entry gate
Improve scrolling/animation latency and bandwidth only if measurements show a
meaningful advantage over display-aware PNG/JPEG plus unchanged-frame suppression.
Record the screenshot baseline first: text readability, input-to-visible p50/p95,
bytes/sec, capture/encode/decode CPU, memory and control latency. Use static text,
forms, scrolling and animation on LAN and representative hosted/mobile networks.

## Approach and decisions
- Keep browser/session ownership, control epochs, private-content fences, explicit
  handoff/return and no-replay input. Replace media only, not agent tools or control.
- Prototype capture/encoding of the owned Chrome target, not the desktop. Decide
  how to obtain frames, codec/text-quality settings and hardware encoder support on
  macOS/Linux before selecting a library or adding dependencies.
- Compare direct Bud-to-viewer connections with TURN relay fallback. Define
  authenticated signaling, short-lived scoped ICE/TURN credentials, network
  exposure, firewall behavior and TURN operating/bandwidth costs. The service must
  authorize owner/Bud/thread/viewer before signaling or establishing any media.
- Epoch changes/private takeover must stop old tracks and clear displayed frames
  promptly. Media reconnection must not reacquire control or resume the agent.
  Prove revocation even for direct peer connections that bypass the service relay.
- Keep resolution separate from CSS viewport; input binds to the actually displayed
  target/document/viewport. Define presentation freshness for video before enabling
  clicks, including resize, tab changes, stalled tracks and old buffered frames.
- Bound buffers and frame rate; prioritize control/renewal over media. No recording,
  DOM replication, audio, general desktop access or new orchestration framework.
- Negotiate optional media capability; screenshots remain fallback for unsupported
  peers and failed video setup. Never replay uncertain input during fallback.

## Acceptance and rollout
Web first; test WKWebView/iOS before claiming mobile support. Cover direct and
TURN paths, multiple viewers, slow clients, background/foreground, NAT changes,
service/Bud restarts, sign-out, revoked grants and takeover during buffered video.
Verify private pixels never reach another viewer/agent/log after fencing. Run a
30-minute resource soak alongside terminal/file traffic. Compare costs and quality
against screenshots; retain screenshots if video does not justify its complexity.

Update daemon/service/web browser specs and docs/proto.md when implementing;
add signaling/stream ownership tests to the auth checklist. No schema or production
network changes are authorized by this future-phase document alone.
