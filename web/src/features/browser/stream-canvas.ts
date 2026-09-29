import type { BrowserFrame } from "./media";

type Header = BrowserFrame & {
  media_generation: string; frame_sequence: number; bitmap_width: number;
  bitmap_height: number; image_bytes: number; source_age_ms: number;
};
type Packet = { header: Header; image: ArrayBuffer };
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

export function parseStreamPacket(raw: ArrayBuffer): Packet {
  if (raw.byteLength < 9 || raw.byteLength > 1024 * 1024 + 4104) throw new Error("stream_bounds");
  const bytes = new Uint8Array(raw);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "BSC1") throw new Error("stream_magic");
  const size = new DataView(raw).getUint32(4);
  if (size < 2 || size > 4096 || 8 + size >= raw.byteLength) throw new Error("stream_header_bounds");
  const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + size)));
  if (![header.media_generation, header.target_id, header.document_id, header.frame_token].every(validId)
    || !(header.viewport_id == null || validId(header.viewport_id))
    || !Number.isSafeInteger(header.frame_sequence) || header.frame_sequence <= 0
    || ![header.width, header.height].every(value => Number.isFinite(value) && value > 0 && value <= 8192)
    || ![header.bitmap_width, header.bitmap_height].every(value => Number.isInteger(value) && value > 0 && value <= 2560)
    || header.bitmap_width * header.bitmap_height > 4_000_000
    || !Number.isFinite(header.source_age_ms) || header.source_age_ms < 0 || header.source_age_ms > 150
    || header.image_bytes !== raw.byteLength - 8 - size || header.image_bytes > 1024 * 1024) throw new Error("stream_header");
  return { header, image: raw.slice(8 + size) };
}

/** One decoding image plus one latest pending image. Metadata changes with pixels. */
export class StreamCanvas {
  private generation = "";
  private sequence = 0;
  private targets: BrowserFrame["targets"] = [];
  private pending?: Packet;
  private decoding = false;
  private closed = false;
  private fenced = false;
  private present: (bitmap: ImageBitmap, frame: BrowserFrame) => void;
  private clear: () => void;
  private send: (message: string) => void;
  private failed: () => void;
  constructor(present: (bitmap: ImageBitmap, frame: BrowserFrame) => void,
    clear: () => void, send: (message: string) => void, failed: () => void) {
    this.present = present; this.clear = clear; this.send = send; this.failed = failed;
  }
  reset(value: { media_version: number; media_generation: string; targets: BrowserFrame["targets"] }) {
    if (value.media_version !== 1 || !validId(value.media_generation) || value.media_generation === this.generation
      || !Array.isArray(value.targets) || value.targets.length > 16
      || !value.targets.every(target => validId(target.target_id) && typeof target.origin === "string" && target.origin.length <= 2048)) throw new Error("stream_reset");
    this.generation = value.media_generation;
    this.fenced = false;
    this.targets = value.targets;
    this.clear();
    if (this.pending) this.ack(this.pending, "discarded");
    this.pending = undefined;
  }
  receive(raw: ArrayBuffer) {
    if (this.closed) return;
    const packet = parseStreamPacket(raw);
    if (packet.header.media_generation !== this.generation || packet.header.frame_sequence <= this.sequence) throw new Error("stream_sequence");
    this.sequence = packet.header.frame_sequence;
    if (this.fenced) { this.ack(packet, "discarded"); return; }
    if (this.pending) this.ack(this.pending, "discarded");
    this.pending = packet;
    if (!this.decoding) void this.drain().catch(() => { this.dispose(); this.failed(); });
  }
  private ack(packet: Packet, disposition: "presented" | "discarded") {
    if (!this.closed) this.send(JSON.stringify({ type: "frame_ack", media_generation: packet.header.media_generation,
      frame_sequence: packet.header.frame_sequence, disposition }));
  }
  private async drain() {
    this.decoding = true;
    try {
      while (this.pending && !this.closed) {
        const packet = this.pending; this.pending = undefined;
        const bitmap = await createImageBitmap(new Blob([packet.image], { type: "image/jpeg" }));
        try {
          if (this.closed) return;
          if (this.fenced || packet.header.media_generation !== this.generation) { this.ack(packet, "discarded"); continue; }
          if (bitmap.width !== packet.header.bitmap_width || bitmap.height !== packet.header.bitmap_height) throw new Error("stream_bitmap_bounds");
          const header = packet.header;
          this.present(bitmap, { target_id: header.target_id, document_id: header.document_id,
            frame_token: header.frame_token, media_generation: header.media_generation, viewport_id: header.viewport_id ?? undefined,
            width: header.width, height: header.height, targets: this.targets });
          this.ack(packet, "presented");
        } finally { bitmap.close(); }
      }
    } finally { this.decoding = false; }
  }
  fence() {
    this.fenced = true;
    this.clear();
    if (this.pending) this.ack(this.pending, "discarded");
    this.pending = undefined;
  }
  dispose() { this.closed = true; this.pending = undefined; this.clear(); }
}
