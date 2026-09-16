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
  authorize: () => Promise<boolean>;
};
type Group = {
  key: string;
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
      const group = this.groups.get(`${session.id}:${session.generation}:${session.control_epoch}:view`);
      if (!group || group.closed || group.owner !== owner || !group.carrier.current()) return false;
      const first = [...group.viewers].find(viewer => viewer.socket.readyState === WebSocket.OPEN && viewer.deadline > Date.now());
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
      if (group.sessionId === id) this.close(group, "control_fence");
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
      for (const viewer of group.viewers)
        if (viewer.deadline < Date.now()) {
          this.onDiagnostic({ session_id: group.sessionId, event: "viewer_timeout", frames: group.frames });
          viewer.socket.terminate();
        }
    }
  }
  private demand(group: Group) {
    if (
      group.closed ||
      group.awaiting ||
      !group.daemon ||
      ![...group.viewers].some((v) => v.ready)
    )
      return;
    group.awaiting = true;
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
    const key = `${session.id}:${session.generation}:${session.control_epoch}:${controllerId ?? "view"}`;
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= 32)
        throw new BrowserError("browser_media_capacity");
      group = {
        key,
        owner,
        sessionId,
        epoch: session.control_epoch,
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
    };
    active.viewers.add(viewer);
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
        if (message.type === "ack") viewer.pixelRatio = message.pixel_ratio;
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
    if (
      group.closed ||
      group.processing ||
      !group.awaiting ||
      raw.length > 1_410_000
    )
      throw new Error("unsolicited frame");
    // Keep awaiting true through authorization; a second frame cannot trigger
    // another demand. The daemon only captures on explicit credit.
    const data = JSON.parse(raw);
    if (data.busy === true) {
      group.awaiting = false;
      setTimeout(() => this.demand(group), 100);
      return;
    }
    group.processing = true;
    const frame = frameSchema.parse(data);
    group.frames++;
    const viewers = [...group.viewers].filter((v) => v.ready);
    for (const viewer of viewers) {
      if (frame.image_format && viewer.pixelRatio === undefined) continue;
      if (!(await viewer.authorize())) {
        viewer.socket.terminate();
        continue;
      }
      const permitted = await this.control.mediaAuthority(
        viewer.owner,
        viewer.sessionId,
        viewer.viewer,
      );
      if (
        group.closed ||
        !group.carrier.current() ||
        permitted.session.control_epoch !== group.epoch ||
        permitted.controllerId !== group.controllerId
      )
        throw new Error("revoked");
      if (viewer.socket.readyState !== WebSocket.OPEN) continue;
      if (viewer.socket.bufferedAmount > 1_410_000) {
        viewer.socket.terminate();
        continue;
      }
      viewer.ready = false;
      viewer.deadline = Date.now() + 5000;
      viewer.socket.send(JSON.stringify({ type: "frame", ...frame }));
    }
    group.processing = false;
    group.awaiting = false;
    this.demand(group);
  }
}
