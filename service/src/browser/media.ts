import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { BrowserControl } from "./control.js";
import { BrowserError } from "./repository.js";
import { dispatchBrowser, type BrowserCarrier } from "./transport.js";

type Viewer = {
  socket: WebSocket;
  owner: string;
  sessionId: string;
  viewer: string;
  ready: boolean;
  pixelRatio?: number;
  deadline: number;
  aliveUntil: number;
  checking: boolean;
  authorizationUntil: number;
  lastFrame: number;
  authorize: () => Promise<boolean>;
};
type Group = {
  key: string;
  browserId: string;
  owner: string;
  sessionId: string;
  epoch: number;
  controllerId?: string;
  generation: string;
  carrier: BrowserCarrier;
  viewers: Set<Viewer>;
  daemon?: WebSocket;
  awaiting: boolean;
  processing: boolean;
  target: string | null;
  closed: boolean;
  frames: number;
  started: number;
  operationDriven: boolean;
  dirty: boolean;
  retries: number;
  nextHeartbeat: number;
  daemonAliveUntil: number;
};
const frameSchema = z
  .object({
    target_id: z.string().max(128),
    document_id: z.string().max(128),
    frame_token: z.string().max(128),
    viewport_id: z.string().max(128).optional(),
    width: z.number().positive().max(8192),
    height: z.number().positive().max(8192),
    image_format: z.literal("png").optional(),
    image: z.string().max(1_400_000),
    targets: z
      .array(
        z.object({
          target_id: z.string().max(128),
          origin: z.string().max(2048),
        }),
      )
      .max(16),
  })
  .strict();

const groupKey = (id: string, generation: string, epoch: number, controller?: string) =>
  `${id}:${generation}:${controller === undefined ? "agent-view" : `${epoch}:${controller}`}`;

/** Latest-only fan-out: slow viewers lose frames, never delay another viewer. */
export class BrowserMedia {
  onDiagnostic: (fields: Record<string, string | number | boolean>) => void = () => {};
  private groups = new Map<string, Group>();
  private tickets = new Map<string, { group: Group; expires: number }>();
  private handshakes = new Set<WebSocket>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private control: BrowserControl,
    private endpoint: string,
    private dispatch = dispatchBrowser,
  ) {
    control.onFence = (id) => this.closeSession(id);
    control.isSizingViewer = (owner, session, viewerId) => {
      const group = this.groups.get(groupKey(session.id, session.generation, session.browser_epoch));
      if (!group || group.closed || group.owner !== owner || !group.carrier.current()) return false;
      const first = [...group.viewers].find(viewer => viewer.socket.readyState === WebSocket.OPEN &&
        (group.operationDriven
          ? viewer.aliveUntil > Date.now() && viewer.authorizationUntil > Date.now() && (viewer.ready || viewer.deadline > Date.now())
          : viewer.deadline > Date.now()));
      return first?.viewer === viewerId;
    };
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  private close(group: Group, reason: string) {
    if (group.closed) return;
    this.onDiagnostic({ session_id: group.sessionId, event: "media_closed", reason, frames: group.frames, age_ms: Date.now() - group.started, viewers: group.viewers.size, awaiting: group.awaiting });
    group.closed = true;
    this.groups.delete(group.key);
    for (const [ticket, entry] of this.tickets)
      if (entry.group === group) this.tickets.delete(ticket);
    group.daemon?.terminate();
    for (const viewer of group.viewers) {
      if (viewer.socket.readyState === WebSocket.OPEN)
        viewer.socket.send(JSON.stringify({ type: "revoked" }));
      viewer.socket.close(1000);
    }
    group.viewers.clear();
  }
  closeSession(id: string) {
    for (const group of this.groups.values())
      if (group.browserId === id || group.sessionId === id) this.close(group, "control_fence");
  }
  stop() {
    clearInterval(this.timer);
    for (const socket of this.handshakes) socket.terminate();
    for (const group of this.groups.values()) this.close(group, "service_stop");
  }
  private sweep() {
    this.control.expireControllers();
    for (const [ticket, entry] of this.tickets)
      if (entry.expires < Date.now()) {
        this.tickets.delete(ticket);
        this.close(entry.group, "ticket_expired");
      }
    for (const group of this.groups.values()) {
      if (!group.carrier.current()) {
        this.close(group, "carrier_changed");
        continue;
      }
      const now = Date.now();
      if (group.operationDriven && group.daemon && group.daemonAliveUntil < now) {
        this.close(group, "daemon_heartbeat_timeout");
        continue;
      }
      if (group.operationDriven && group.nextHeartbeat <= now) {
        group.nextHeartbeat = now + 3000;
        if (group.daemon?.readyState === WebSocket.OPEN) group.daemon.ping();
        for (const viewer of group.viewers) {
          if (viewer.socket.readyState !== WebSocket.OPEN) continue;
          viewer.socket.ping();
          if (!viewer.checking) {
            viewer.checking = true;
            void this.checkViewer(group, viewer)
              .then(ok => { if (!ok) viewer.socket.terminate(); else viewer.authorizationUntil = Date.now() + 10_000; })
              .catch(() => viewer.socket.terminate())
              .finally(() => { viewer.checking = false; });
          }
        }
      }
      for (const viewer of group.viewers)
        if ((!viewer.ready && viewer.deadline < now) ||
            (group.operationDriven ? viewer.aliveUntil < now || viewer.authorizationUntil < now : viewer.deadline < now)) {
          this.onDiagnostic({ session_id: group.sessionId, event: "viewer_timeout", frames: group.frames });
          viewer.socket.terminate();
        }
    }
  }
  private async checkViewer(group: Group, viewer: Viewer): Promise<boolean> {
    if (!(await viewer.authorize())) return false;
    const permitted = await this.control.mediaAuthority(viewer.owner, viewer.sessionId, viewer.viewer);
    return !group.closed && group.carrier.current()
      && permitted.carrier.tracker === group.carrier.tracker
      && permitted.session.generation === group.generation
      && (group.controllerId === undefined || permitted.session.browser_epoch === group.epoch)
      && permitted.controllerId === group.controllerId;
  }
  private demand(group: Group) {
    if (
      group.closed ||
      group.awaiting ||
      (group.operationDriven && !group.dirty) ||
      !group.daemon ||
      ![...group.viewers].some((v) => v.ready)
    )
      return;
    group.awaiting = true;
    group.dirty = false;
    const viewers = [...group.viewers];
    const pixelRatio = group.carrier.hidpiCapture && viewers.every(v => v.pixelRatio !== undefined)
      ? Math.min(...viewers.map(v => v.pixelRatio!)) : undefined;
    group.daemon.send(JSON.stringify({ target_id: group.target, pixel_ratio: pixelRatio }));
  }
  async attachViewer(
    socket: WebSocket,
    owner: string,
    sessionId: string,
    viewerId: string,
    authorize: () => Promise<boolean>,
  ) {
    const { session, carrier, controllerId } =
      await this.control.mediaAuthority(owner, sessionId, viewerId);
    if (socket.readyState !== WebSocket.OPEN) return;
    const key = groupKey(session.id, session.generation, session.browser_epoch, controllerId);
    let group = this.groups.get(key);
    if (group && (!group.carrier.current() || group.carrier.tracker !== carrier.tracker)) { this.close(group, "carrier_changed"); group = undefined; }
    if (!group) {
      if (this.groups.size >= 32)
        throw new BrowserError("browser_media_capacity");
      group = {
        key,
        browserId: session.browser_id,
        owner,
        sessionId,
        epoch: session.browser_epoch,
        controllerId,
        generation: session.generation,
        carrier,
        viewers: new Set(),
        awaiting: false,
        processing: false,
        target: null,
        closed: false,
        frames: 0,
        started: Date.now(),
        operationDriven: carrier.operationDrivenMedia === true && !controllerId,
        dirty: true,
        retries: 0,
        nextHeartbeat: Date.now() + 3000,
        daemonAliveUntil: Date.now() + 60_000,
      };
      this.groups.set(key, group);
    }
    if (group.viewers.size >= 3) throw new BrowserError("browser_viewer_limit");
    const active = group;
    const viewer: Viewer = {
      socket,
      owner,
      sessionId,
      viewer: viewerId,
      authorize,
      ready: true,
      deadline: Date.now() + 10_000,
      aliveUntil: Date.now() + 10_000,
      checking: false,
      authorizationUntil: Date.now() + 10_000,
      lastFrame: 0,
    };
    active.viewers.add(viewer);
    active.dirty = true; // A new viewer needs pixels even when the agent is idle.
    socket.on("pong", () => { viewer.aliveUntil = Date.now() + 10_000; });
    socket.on("message", (raw) => {
      if (Buffer.byteLength(raw.toString()) > 512) {
        socket.terminate();
        return;
      }
      try {
        const message = z
          .object({
            type: z.enum(["ack", "target"]),
            target_id: z.string().max(128).optional(),
            pixel_ratio: z.number().min(1).max(2).optional(),
          })
          .strict()
          .parse(JSON.parse(raw.toString()));
        if (message.type === "target") {
          // View-only clients cannot change the shared selected page.
          if (!active.controllerId || !message.target_id)
            throw new Error("no control");
          active.target = message.target_id;
        }
        if (message.type === "ack") {
          if (viewer.pixelRatio !== message.pixel_ratio) active.dirty = true;
          viewer.pixelRatio = message.pixel_ratio;
        }
        // A slow viewer may have missed the latest shared frame while decoding.
        if (viewer.lastFrame < active.frames) active.dirty = true;
        viewer.ready = true;
        viewer.deadline = Date.now() + 10_000;
        this.demand(active);
      } catch {
        socket.terminate();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      active.viewers.delete(viewer);
      if (!active.viewers.size) this.close(active, "last_viewer_closed");
    });
    if (active.daemon) {
      this.demand(active);
      return;
    }
    if ([...this.tickets.values()].some((t) => t.group === active)) return;
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { group: active, expires: Date.now() + 5000 });
    const request = this.control.repository.command(session, {
      action: "media_attach",
      endpoint: this.endpoint,
      ticket,
      controller_id: controllerId ?? null,
      ...(active.operationDriven ? { operation_driven: true } : {}),
    });
    const signal = AbortSignal.timeout(4000);
    let result = await this.dispatch(carrier, request, signal);
    // The preceding epoch's media task may still be closing. This admission
    // rejection captured nothing; retry only that specific pre-attach result.
    while (
      !active.closed &&
      !signal.aborted &&
      result.error === "browser_media_busy"
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      result = await this.dispatch(carrier, request, signal);
    }
    if (!result.ok) this.close(active, "attach_rejected");
  }
  attachDaemon(socket: WebSocket) {
    if (this.handshakes.size >= 32) {
      socket.terminate();
      return;
    }
    this.handshakes.add(socket);
    const timeout = setTimeout(() => socket.terminate(), 3000);
    socket.once("message", (raw) => {
      clearTimeout(timeout);
      this.handshakes.delete(socket);
      try {
        if (Buffer.byteLength(raw.toString()) > 256) throw new Error("size");
        const { ticket } = z
          .object({ ticket: z.string().max(128) })
          .strict()
          .parse(JSON.parse(raw.toString()));
        const entry = this.tickets.get(ticket);
        this.tickets.delete(ticket);
        if (
          !entry ||
          entry.expires < Date.now() ||
          entry.group.closed ||
          !entry.group.carrier.current()
        )
          throw new Error("grant");
        const group = entry.group;
        if (group.daemon) throw new Error("duplicate");
        group.daemon = socket;
        socket.on("pong", () => { group.daemonAliveUntil = Date.now() + 60_000; });
        socket.on("message", (raw) => {
          void this.frame(group, raw.toString()).catch((error) => this.close(group,
            error instanceof z.ZodError ? "invalid_frame" :
            error instanceof BrowserError ? "media_authority_rejected" : "frame_processing_failed"));
        });
        socket.on("close", () => this.close(group, "daemon_closed"));
        this.demand(group);
      } catch {
        socket.terminate();
      }
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      this.handshakes.delete(socket);
    });
    socket.on("error", () => {});
  }
  private async frame(group: Group, raw: string) {
    if (group.closed || raw.length > 1_410_000) throw new Error("invalid media");
    const data = JSON.parse(raw);
    if (group.operationDriven && data.refresh === true) {
      z.object({ refresh: z.literal(true) }).strict().parse(data);
      group.dirty = true;
      this.demand(group);
      return;
    }
    if (
      group.closed ||
      group.processing ||
      !group.awaiting ||
      raw.length > 1_410_000
    )
      throw new Error("unsolicited frame");
    // Keep awaiting true through authorization; a second frame cannot trigger
    // another demand. The daemon only captures on explicit credit.
    if (data.busy === true) {
      group.awaiting = false;
      group.dirty = true;
      if (group.operationDriven && ++group.retries > 3) {
        this.close(group, "capture_retries_exhausted");
        return;
      }
      setTimeout(() => this.demand(group), 100);
      return;
    }
    group.processing = true;
    const frame = frameSchema.parse(data);
    group.frames++;
    group.retries = 0;
    const viewers = [...group.viewers].filter((v) => v.ready);
    for (const viewer of viewers) {
      if (frame.image_format && viewer.pixelRatio === undefined) {
        group.dirty = true; // A newly joined legacy-quality viewer needs JPEG.
        continue;
      }
      if (!(await this.checkViewer(group, viewer))) {
        viewer.socket.terminate();
        continue;
      }
      if (group.closed || !group.carrier.current() || viewer.socket.readyState !== WebSocket.OPEN) continue;
      if (viewer.socket.bufferedAmount > 1_410_000) {
        viewer.socket.terminate();
        continue;
      }
      viewer.ready = false;
      viewer.lastFrame = group.frames;
      viewer.deadline = Date.now() + 5000;
      viewer.socket.send(JSON.stringify({ type: "frame", ...frame }));
    }
    group.processing = false;
    group.awaiting = false;
    this.demand(group);
  }
}
