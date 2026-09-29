import { WebSocket } from "ws";
import { z } from "zod";

const id = z.string().min(1).max(128);
export const streamHeader = z.object({
  media_generation: id, frame_sequence: z.number().int().positive().safe(),
  target_id: id, document_id: id, frame_token: id, viewport_id: id.nullable().optional(),
  width: z.number().positive().max(8192), height: z.number().positive().max(8192),
  bitmap_width: z.number().int().positive().max(2560), bitmap_height: z.number().int().positive().max(2560),
  image_bytes: z.number().int().positive().max(1024 * 1024), source_age_ms: z.number().nonnegative().max(150),
}).strict();
export function parseStreamPacket(raw: Buffer) {
  if (raw.length < 9 || raw.length > 1024 * 1024 + 4104 || raw.subarray(0, 4).toString() !== "BSC1") throw new Error("stream_bounds");
  const length = raw.readUInt32BE(4);
  if (length < 2 || length > 4096 || 8 + length >= raw.length) throw new Error("stream_header_bounds");
  const header = streamHeader.parse(JSON.parse(raw.subarray(8, 8 + length).toString("utf8")));
  if (header.image_bytes !== raw.length - 8 - length || header.bitmap_width * header.bitmap_height > 4_000_000) throw new Error("stream_image_bounds");
  return header;
}

/** One private viewer. Bounded authorization work, pending bytes and downstream credit. */
export class PrivateStreamRelay {
  private generation = "";
  private sequence = 0;
  private deliveredGeneration = "";
  private outstanding = new Map<number, { generation: string; bytes: number; at: number; forwarded: boolean }>();
  private pending?: { raw: Buffer; sequence: number; generation: string };
  private resetting?: Promise<void>;
  private pendingReset?: { raw: string; generation: string };
  private resetAt = 0;
  private processing = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private daemon: WebSocket, private viewer: WebSocket,
    private authorize: () => Promise<boolean>, private fail: () => void) {
    this.timer = setInterval(() => {
      if ((this.resetAt && Date.now() - this.resetAt > 1000) || [...this.outstanding.values()].some(value => Date.now() - value.at > 1000)) this.closeWithFailure();
    }, 100);
    this.timer.unref();
  }
  dispose() { this.closed = true; clearInterval(this.timer); this.pending = undefined; this.pendingReset = undefined; this.outstanding.clear(); }
  private closeWithFailure() { if (!this.closed) { this.dispose(); this.fail(); } }
  reset(raw: string) {
    if (Buffer.byteLength(raw) > 40 * 1024) throw new Error("stream_reset_bounds");
    if (this.closed) throw new Error("stream_closed");
    const value = z.object({ type: z.literal("reset"), media_version: z.literal(1), media_generation: id,
      targets: z.array(z.object({ target_id: id, origin: z.string().max(2048) }).strict()).max(16) }).strict().parse(JSON.parse(raw));
    // Fence immediately, even while the previous authorization is pending.
    if (this.generation === value.media_generation) throw new Error("stream_duplicate_generation");
    this.generation = value.media_generation;
    if (this.pending) { this.retire(this.pending.sequence, this.pending.generation, "discarded"); this.pending = undefined; }
    this.pendingReset = { raw: JSON.stringify(value), generation: value.media_generation };
    if (!this.resetting) {
      this.resetAt = Date.now();
      this.resetting = this.applyResets().finally(() => { this.resetting = undefined; this.resetAt = 0; });
    }
    return this.resetting;
  }
  private async applyResets() {
    // One authorization in flight and one latest reset: no unbounded queue.
    // The original deadline is retained when a newer generation supersedes it.
    while (this.pendingReset && !this.closed) {
      const reset = this.pendingReset; this.pendingReset = undefined;
      if (!(await this.authorize()) || this.closed) return this.closeWithFailure();
      if (reset.generation !== this.generation) continue;
      if (this.viewer.readyState !== WebSocket.OPEN || this.viewer.bufferedAmount > 2 * 1024 * 1024) return this.closeWithFailure();
      this.viewer.send(reset.raw);
      this.deliveredGeneration = reset.generation;
    }
  }
  frame(raw: Buffer) {
    const header = parseStreamPacket(raw);
    if (this.closed || header.media_generation !== this.generation || header.frame_sequence <= this.sequence) throw new Error("stream_sequence");
    const bytes = [...this.outstanding.values()].reduce((sum, item) => sum + item.bytes, 0);
    if (this.outstanding.size >= 3 || bytes + raw.length > 2 * 1024 * 1024) throw new Error("stream_credit");
    this.sequence = header.frame_sequence;
    this.outstanding.set(header.frame_sequence, { generation: header.media_generation, bytes: raw.length, at: Date.now(), forwarded: false });
    if (this.pending) this.retire(this.pending.sequence, this.pending.generation, "discarded");
    this.pending = { raw, sequence: header.frame_sequence, generation: header.media_generation };
    if (!this.processing) void this.drain().catch(() => this.closeWithFailure());
  }
  private async drain() {
    this.processing = true;
    try {
      while (this.pending && !this.closed) {
        const frame = this.pending; this.pending = undefined;
        await this.resetting;
        if (this.closed) return;
        const allowed = await this.authorize();
        if (this.closed) return;
        if (!allowed || this.viewer.readyState !== WebSocket.OPEN) return this.closeWithFailure();
        if (frame.generation !== this.generation || frame.generation !== this.deliveredGeneration) { this.retire(frame.sequence, frame.generation, "discarded"); continue; }
        if (this.viewer.bufferedAmount + frame.raw.length > 2 * 1024 * 1024) return this.closeWithFailure();
        const credit = this.outstanding.get(frame.sequence)!;
        if (Date.now() - credit.at > 150) { this.retire(frame.sequence, frame.generation, "discarded"); continue; }
        credit.forwarded = true;
        this.viewer.send(frame.raw, { binary: true });
      }
    } finally { this.processing = false; }
  }
  feedback(raw: string) {
    const value = z.object({ type: z.literal("frame_ack"), media_generation: id,
      frame_sequence: z.number().int().positive().safe(), disposition: z.enum(["presented", "discarded"]) }).strict().parse(JSON.parse(raw));
    if (!this.outstanding.get(value.frame_sequence)?.forwarded) throw new Error("stream_unforwarded_ack");
    this.retire(value.frame_sequence, value.media_generation, value.disposition);
  }
  private retire(sequence: number, generation: string, disposition: string) {
    const item = this.outstanding.get(sequence);
    if (!item || item.generation !== generation) throw new Error("stream_invalid_ack");
    this.outstanding.delete(sequence);
    if (!this.closed && this.daemon.readyState === WebSocket.OPEN) {
      this.daemon.send(JSON.stringify({ type: "frame_ack", media_generation: generation, frame_sequence: sequence, disposition }));
    }
  }
}

// Never copy arbitrary exception messages (which can contain page data) into logs.
export function streamErrorCode(error: unknown): string {
  if (error instanceof z.ZodError) return "stream_schema";
  if (error instanceof SyntaxError) return "stream_json";
  const codes = ["stream_bounds", "stream_header_bounds", "stream_image_bounds", "stream_reset_bounds",
    "stream_closed", "stream_duplicate_generation", "stream_sequence", "stream_credit",
    "stream_unforwarded_ack", "stream_invalid_ack", "stream_not_started"];
  return error instanceof Error && codes.includes(error.message) ? error.message : "redacted";
}
