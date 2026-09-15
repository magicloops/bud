export type BrowserFrame = {
  target_id: string;
  document_id: string;
  frame_token: string;
  viewport_id?: string;
  width: number;
  height: number;
  targets: { target_id: string; origin: string }[];
};

/** The socket grants one frame of credit only after decoding and drawing. */
export class BrowserCanvas {
  private socket: WebSocket;
  private disposed = false;
  private decoding = false;
  private canvas: HTMLCanvasElement;
  private captureRatio: () => number | undefined;
  private status: (
    state: "connected" | "unavailable",
    targets?: BrowserFrame["targets"],
  ) => void;
  frame: BrowserFrame | null = null;
  constructor(
    canvas: HTMLCanvasElement,
    url: string,
    viewerId: string,
    status: (
      state: "connected" | "unavailable",
      targets?: BrowserFrame["targets"],
    ) => void,
    captureRatio: () => number | undefined = () => undefined,
  ) {
    this.canvas = canvas;
    this.captureRatio = captureRatio;
    this.status = status;
    this.socket = new WebSocket(url);
    this.socket.onopen = () =>
      this.socket.send(JSON.stringify({ viewer_id: viewerId }));
    this.socket.onmessage = (event) => {
      void this.draw(event.data).catch(() => this.close());
    };
    this.socket.onclose = () => {
      if (!this.disposed) {
        this.disposed = true;
        this.clear();
        this.status("unavailable");
      }
    };
    this.socket.onerror = () => this.close();
  }
  private clear() {
    this.frame = null;
    this.canvas
      .getContext("2d")
      ?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  private async draw(raw: unknown) {
    if (this.disposed) return;
    if (typeof raw !== "string" || raw.length > 1_420_000 || this.decoding)
      throw new Error("invalid frame");
    const data = JSON.parse(raw);
    if (data.type === "revoked") {
      this.close();
      return;
    }
    if (
      data.type !== "frame" ||
      typeof data.image !== "string" ||
      data.image.length > 1_400_000 ||
      !Number.isFinite(data.width) ||
      !Number.isFinite(data.height) ||
      data.width <= 0 ||
      data.height <= 0 ||
      data.width > 8192 ||
      data.height > 8192 ||
      !Array.isArray(data.targets) ||
      data.targets.length > 16
    )
      throw new Error("invalid frame");
    this.decoding = true;
    let bitmap: ImageBitmap | undefined;
    try {
      const bytes = Uint8Array.from(atob(data.image), (character) =>
        character.charCodeAt(0),
      );
      bitmap = await createImageBitmap(
        new Blob([bytes], { type: data.image_format === "png" ? "image/png" : "image/jpeg" }),
      );
      if (this.disposed) return;
      if (bitmap.width > 2560 || bitmap.height > 2560 || bitmap.width * bitmap.height > 4_000_000)
        throw new Error("invalid frame size");
      const bounds = this.canvas.parentElement?.getBoundingClientRect();
      const displayScale = bounds ? Math.min(1, bounds.width / data.width, bounds.height / data.height) : 1;
      if (this.canvas.width !== bitmap.width) this.canvas.width = bitmap.width;
      if (this.canvas.height !== bitmap.height)
        this.canvas.height = bitmap.height;
      // Bitmap density is a transport choice, never remote layout geometry.
      this.canvas.style.width = `${data.width * displayScale}px`;
      this.canvas.style.height = `${data.height * displayScale}px`;
      this.canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      this.frame = {
        target_id: data.target_id,
        document_id: data.document_id,
        frame_token: data.frame_token,
        viewport_id: data.viewport_id,
        width: data.width,
        height: data.height,
        targets: data.targets,
      };
      this.status("connected", data.targets);
      this.socket.send(JSON.stringify({ type: "ack", pixel_ratio: this.captureRatio() }));
    } finally {
      bitmap?.close();
      this.decoding = false;
    }
  }
  selectTarget(id: string) {
    this.frame = null;
    this.socket.send(JSON.stringify({ type: "target", target_id: id }));
  }
  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.socket.close();
    this.status("unavailable");
  }
}
