import { Buffer } from "node:buffer";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { EnvelopeSchema } from "../ws/protocol.js";

const FileOpenErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const FileOpenResultSchema = EnvelopeSchema.extend({
  type: z.literal("file_open_result"),
  operation_id: z.string().optional(),
  stream_id: z.string(),
  accepted: z.boolean(),
  status_code: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string()).optional().default({}),
  content_identity: z.record(z.unknown()).optional(),
  size: z.number().int().nonnegative().optional(),
  error: FileOpenErrorSchema.optional(),
});

export type FileOpenResultFrame = z.infer<typeof FileOpenResultSchema>;
export type FileOpenError = z.infer<typeof FileOpenErrorSchema>;

const fileRuntimeStreams = new Map<string, FileRuntimeStream>();

export class FileRuntimeStream {
  readonly body = new PassThrough();
  private openResult: FileOpenResultFrame | null = null;
  private openResolve: ((frame: FileOpenResultFrame) => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private completed = false;
  private closedBeforeOpenResult = false;
  private receivedBytes = 0;

  constructor(
    readonly streamId: string,
    readonly operationId: string,
    private readonly cleanup: () => void,
    private readonly options: { maxReceivedBytes?: number } = {},
  ) {
    this.body.on("error", () => {
      // Stream errors are surfaced through the open promise or Fastify response.
    });
  }

  waitForOpen(timeoutMs: number): Promise<FileOpenResultFrame> {
    if (this.openResult) {
      return Promise.resolve(this.openResult);
    }
    if (this.completed) {
      return Promise.reject(new Error("file stream closed before open result"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openResolve = null;
        this.openReject = null;
        reject(new Error("file open timed out"));
      }, timeoutMs);

      this.openResolve = (frame) => {
        clearTimeout(timeout);
        this.openResolve = null;
        this.openReject = null;
        resolve(frame);
      };
      this.openReject = (err) => {
        clearTimeout(timeout);
        this.openResolve = null;
        this.openReject = null;
        reject(err);
      };
    });
  }

  handleOpenResult(frame: FileOpenResultFrame): void {
    if (this.completed && !this.closedBeforeOpenResult) {
      return;
    }
    this.openResult = frame;
    this.openResolve?.(frame);
    if (this.closedBeforeOpenResult) {
      this.completed = true;
      this.cleanup();
    }
  }

  async handleData(chunk: Buffer): Promise<void> {
    if (this.completed) {
      throw new Error("file stream is already closed");
    }
    if (chunk.byteLength === 0) {
      return;
    }
    const nextReceivedBytes = this.receivedBytes + chunk.byteLength;
    if (
      this.options.maxReceivedBytes !== undefined &&
      nextReceivedBytes > this.options.maxReceivedBytes
    ) {
      const err = new Error(`file response exceeded max bytes ${this.options.maxReceivedBytes}`);
      this.completed = true;
      this.openReject?.(err);
      this.body.destroy(err);
      this.cleanup();
      throw err;
    }
    this.receivedBytes = nextReceivedBytes;
    if (this.body.write(chunk)) {
      return;
    }
    await Promise.race([
      once(this.body, "drain"),
      once(this.body, "error").then(([err]) => {
        throw err instanceof Error ? err : new Error("file response stream errored");
      }),
      once(this.body, "close").then(() => {
        if (!this.completed) {
          throw new Error("file response stream closed");
        }
      }),
    ]);
  }

  handleReset(args: {
    reason: string;
    error?: FileOpenError;
  }): void {
    if (this.completed) {
      return;
    }
    this.completed = true;
    const err = new Error(args.error?.message ?? args.reason);
    this.openReject?.(err);
    this.body.destroy(err);
    this.cleanup();
  }

  handleClose(): void {
    if (this.completed) {
      return;
    }
    if (!this.openResult) {
      this.closedBeforeOpenResult = true;
      this.body.end();
      return;
    }
    this.completed = true;
    this.body.end();
    this.cleanup();
  }

  abortFromClient(): void {
    this.handleReset({
      reason: "client_closed",
      error: {
        code: "CLIENT_CLOSED",
        message: "browser client closed the file response",
        retryable: false,
      },
    });
  }

  isComplete(): boolean {
    return this.completed;
  }
}

export function registerFileRuntimeStream(stream: FileRuntimeStream): void {
  fileRuntimeStreams.set(stream.streamId, stream);
}

export function getFileRuntimeStream(streamId: string): FileRuntimeStream | null {
  return fileRuntimeStreams.get(streamId) ?? null;
}

export function deleteFileRuntimeStream(streamId: string): void {
  fileRuntimeStreams.delete(streamId);
}

export function handleFileOpenResult(raw: unknown): FileOpenResultFrame | null {
  const result = FileOpenResultSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const stream = getFileRuntimeStream(result.data.stream_id);
  if (!stream) {
    return result.data;
  }
  stream.handleOpenResult(result.data);
  return result.data;
}
