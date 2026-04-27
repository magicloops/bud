import { Buffer } from "node:buffer";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { EnvelopeSchema } from "../ws/protocol.js";

const ProxyOpenErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const ProxyOpenResultSchema = EnvelopeSchema.extend({
  type: z.literal("proxy_open_result"),
  operation_id: z.string().optional(),
  stream_id: z.string(),
  accepted: z.boolean(),
  status_code: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string()).optional().default({}),
  error: ProxyOpenErrorSchema.optional(),
});

export type ProxyOpenResultFrame = z.infer<typeof ProxyOpenResultSchema>;
export type ProxyOpenError = z.infer<typeof ProxyOpenErrorSchema>;

const proxyRuntimeStreams = new Map<string, ProxyRuntimeStream>();

export class ProxyRuntimeStream {
  readonly body = new PassThrough();
  private openResult: ProxyOpenResultFrame | null = null;
  private openResolve: ((frame: ProxyOpenResultFrame) => void) | null = null;
  private openReject: ((err: Error) => void) | null = null;
  private completed = false;

  constructor(
    readonly streamId: string,
    readonly operationId: string,
    private readonly cleanup: () => void,
  ) {
    this.body.on("error", () => {
      // Stream errors are surfaced through the open promise or Fastify response.
    });
  }

  waitForOpen(timeoutMs: number): Promise<ProxyOpenResultFrame> {
    if (this.openResult) {
      return Promise.resolve(this.openResult);
    }
    if (this.completed) {
      return Promise.reject(new Error("proxy stream closed before open result"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openResolve = null;
        this.openReject = null;
        reject(new Error("proxy open timed out"));
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

  handleOpenResult(frame: ProxyOpenResultFrame): void {
    if (this.completed) {
      return;
    }
    this.openResult = frame;
    this.openResolve?.(frame);
  }

  async handleData(chunk: Buffer): Promise<void> {
    if (this.completed) {
      throw new Error("proxy stream is already closed");
    }
    if (chunk.byteLength === 0) {
      return;
    }
    if (this.body.write(chunk)) {
      return;
    }
    await Promise.race([
      once(this.body, "drain"),
      once(this.body, "error").then(([err]) => {
        throw err instanceof Error ? err : new Error("proxy response stream errored");
      }),
      once(this.body, "close").then(() => {
        if (!this.completed) {
          throw new Error("proxy response stream closed");
        }
      }),
    ]);
  }

  handleReset(args: {
    reason: string;
    error?: ProxyOpenError;
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
    this.completed = true;
    this.body.end();
    this.cleanup();
  }

  abortFromClient(): void {
    this.handleReset({
      reason: "client_closed",
      error: {
        code: "CLIENT_CLOSED",
        message: "browser client closed the proxy response",
        retryable: false,
      },
    });
  }

  isComplete(): boolean {
    return this.completed;
  }
}

export function registerProxyRuntimeStream(stream: ProxyRuntimeStream): void {
  proxyRuntimeStreams.set(stream.streamId, stream);
}

export function getProxyRuntimeStream(streamId: string): ProxyRuntimeStream | null {
  return proxyRuntimeStreams.get(streamId) ?? null;
}

export function deleteProxyRuntimeStream(streamId: string): void {
  proxyRuntimeStreams.delete(streamId);
}

export function handleProxyOpenResult(raw: unknown): ProxyOpenResultFrame | null {
  const result = ProxyOpenResultSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const stream = getProxyRuntimeStream(result.data.stream_id);
  if (!stream) {
    return result.data;
  }
  stream.handleOpenResult(result.data);
  return result.data;
}
