import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { RawData } from "ws";
import { ulid } from "ulid";
import { randomBytes, createHmac } from "node:crypto";
import { z } from "zod";
import { db } from "../db/client.js";
import { budTable, enrollmentTokenTable } from "../db/schema.js";
import { PROTO_VERSION, config } from "../config.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { RunManager } from "../runtime/run-manager.js";

type HelloFrame = z.infer<typeof HelloSchema>;
type HelloWithBudId = HelloFrame & { bud_id: string };

const EnvelopeSchema = z.object({
  proto: z.literal(PROTO_VERSION),
  type: z.string(),
  id: z.string(),
  ts: z.number(),
  ext: z.record(z.unknown()).default({})
});

const CapabilitiesSchema = z
  .object({
    max_concurrency: z.number().int().positive().default(1),
    supports_pty: z.boolean().default(false),
    shell_default: z.string().optional()
  })
  .default({
    max_concurrency: 1,
    supports_pty: false
  });

const HelloSchema = EnvelopeSchema.extend({
  type: z.literal("hello"),
  name: z.string(),
  os: z.string(),
  arch: z.string(),
  version: z.string().optional(),
  token: z.string().optional(),
  bud_id: z.string().optional(),
  capabilities: CapabilitiesSchema
});

const HelloProofSchema = EnvelopeSchema.extend({
  type: z.literal("hello_proof"),
  bud_id: z.string(),
  hmac: z.string()
});

const StreamSchema = EnvelopeSchema.extend({
  type: z.union([z.literal("stdout"), z.literal("stderr")]),
  run_id: z.string(),
  seq: z.number().int().nonnegative(),
  data: z.string()
});

const RunFinishedSchema = EnvelopeSchema.extend({
  type: z.literal("run_finished"),
  run_id: z.string(),
  exit_code: z.number().int().nullable().optional(),
  canceled: z.boolean().optional(),
  signal: z.string().optional()
});

const HeartbeatSchema = EnvelopeSchema.extend({
  type: z.literal("heartbeat")
});

const ErrorFrameSchema = EnvelopeSchema.extend({
  type: z.literal("error"),
  code: z.string(),
  message: z.string()
});

type ConnectionState =
  | { kind: "awaiting_hello" }
  | {
      kind: "awaiting_proof";
      budId: string;
      deviceSecret: string;
      nonce: string;
      hello: HelloFrame;
    }
  | {
      kind: "connected";
      budId: string;
      sessionId: string;
      hello: HelloFrame;
    }
  | { kind: "closed" };

interface SessionTracker {
  budId: string;
  sessionId: string;
  lastHeartbeat: number;
  socket: WebSocket;
  timeout?: NodeJS.Timeout;
}

type SocketStreamLike = {
  socket: WebSocket;
};

const sessions = new Map<string, SessionTracker>();

export function sendFrameToBud(budId: string, payload: Record<string, unknown>): boolean {
  const session = sessions.get(budId);
  if (!session) {
    return false;
  }
  if (session.socket.readyState !== session.socket.OPEN) {
    return false;
  }
  session.socket.send(JSON.stringify(payload));
  return true;
}

export async function registerWsGateway(server: FastifyInstance, runManager: RunManager) {
  server.get("/ws", { websocket: true }, (stream: unknown) => {
    const socketStream = stream as SocketStreamLike;
    const connection = new BudConnection(server, socketStream, runManager);
    connection.start().catch((err) => {
      server.log.error({ err }, "WS connection failed");
      socketStream.socket.close();
    });
  });
}

class BudConnection {
  private state: ConnectionState = { kind: "awaiting_hello" };
  private lastPresenceWrite = 0;

  constructor(
    private server: FastifyInstance,
    private stream: SocketStreamLike,
    private runManager: RunManager
  ) {
    stream.socket.on("close", () => {
      void this.handleClose();
    });
  }

  async start() {
    this.stream.socket.on("message", (raw: RawData) => {
      if (typeof raw === "string") {
        void this.handleRaw(raw);
        return;
      }
      if (Buffer.isBuffer(raw)) {
        void this.handleRaw(raw.toString("utf-8"));
        return;
      }
      if (Array.isArray(raw)) {
        raw.forEach((chunk) => {
          if (Buffer.isBuffer(chunk)) {
            void this.handleRaw(chunk.toString("utf-8"));
          }
        });
        return;
      }
      if (raw instanceof ArrayBuffer) {
        void this.handleRaw(Buffer.from(raw).toString("utf-8"));
      }
    });
  }

  private async handleRaw(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.server.log.warn({ err }, "Failed to parse WS frame");
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid JSON");
      this.stream.socket.close();
      return;
    }

    const envelope = EnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Invalid envelope");
      this.stream.socket.close();
      return;
    }

    switch (envelope.data.type) {
      case "hello":
        await this.handleHello(parsed);
        break;
      case "hello_proof":
        await this.handleHelloProof(parsed);
        break;
      case "heartbeat":
        await this.handleHeartbeat(envelope.data.ts);
        break;
      case "stdout":
      case "stderr":
        await this.handleStreamFrame(parsed);
        break;
      case "run_finished":
        await this.handleRunFinished(parsed);
        break;
      default:
        this.server.log.warn({ type: envelope.data.type }, "Unhandled WS frame type");
        break;
    }
  }

  private async handleStreamFrame(raw: unknown) {
    const result = StreamSchema.safeParse(raw);
    if (!result.success) {
      return;
    }
    await this.runManager.handleStreamChunk(
      result.data.run_id,
      result.data.type,
      result.data.data,
      result.data.seq
    );
  }

  private async handleRunFinished(raw: unknown) {
    const result = RunFinishedSchema.safeParse(raw);
    if (!result.success) {
      return;
    }
    await this.runManager.handleRunFinished(result.data.run_id, {
      exit_code: result.data.exit_code ?? null,
      canceled: result.data.canceled,
      signal: result.data.signal
    });
  }

  private async handleHello(raw: unknown) {
    const result = HelloSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("PROTO_VERSION_MISMATCH", "Malformed hello frame");
      this.stream.socket.close();
      return;
    }
    const frame = result.data;
    if (frame.token) {
      await this.handleEnrollmentHello(frame);
      return;
    }
    if (frame.bud_id) {
      await this.issueChallenge(frame as HelloWithBudId);
      return;
    }
    await this.sendError("AUTH_FAILED", "hello requires token or bud_id");
    this.stream.socket.close();
  }

  private async handleEnrollmentHello(frame: HelloFrame) {
    if (!frame.token) {
      await this.sendError("AUTH_FAILED", "Missing enrollment token");
      this.stream.socket.close();
      return;
    }
    const tokenHash = hashToken(frame.token);
    const tokenRow = await db.query.enrollmentTokenTable.findFirst({
      where: and(
        eq(enrollmentTokenTable.tokenHash, tokenHash),
        isNull(enrollmentTokenTable.consumedAt),
        gt(enrollmentTokenTable.expiresAt, new Date())
      )
    });
    if (!tokenRow) {
      await this.sendError("AUTH_FAILED", "Enrollment token invalid or expired");
      this.stream.socket.close();
      return;
    }

    const budId = `b_${ulid()}`;
    const deviceSecret = randomBytes(32).toString("base64url");
    const sessionId = `s_${ulid()}`;
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx
        .insert(budTable)
        .values({
          budId,
          name: frame.name,
          os: frame.os,
          arch: frame.arch,
          version: frame.version,
          status: "online",
          lastSeenAt: now,
          deviceSecret
        })
        .onConflictDoUpdate({
          target: budTable.budId,
          set: {
            name: frame.name,
            os: frame.os,
            arch: frame.arch,
            version: frame.version,
            status: "online",
            lastSeenAt: now
          }
        });

      await tx
        .update(enrollmentTokenTable)
        .set({ consumedAt: now })
        .where(eq(enrollmentTokenTable.tokenHash, tokenHash));
    });

    this.server.log.info({ budId }, "Bud enrolled");
    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      device_secret: deviceSecret,
      heartbeat_sec: config.heartbeatSec
    });

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello: frame
    };
    this.registerSession(budId, sessionId);
  }

  private async issueChallenge(frame: HelloWithBudId) {
    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, frame.bud_id)
    });
    if (!bud || !bud.deviceSecret) {
      await this.sendError("AUTH_FAILED", "Unknown bud_id");
      this.stream.socket.close();
      return;
    }

    const nonce = randomBytes(32).toString("base64url");
    this.state = {
      kind: "awaiting_proof",
      budId: bud.budId,
      deviceSecret: bud.deviceSecret,
      nonce,
      hello: frame
    };
    await this.sendFrame("hello_challenge", { nonce });
  }

  private async handleHelloProof(raw: unknown) {
    const result = HelloProofSchema.safeParse(raw);
    if (!result.success) {
      await this.sendError("AUTH_FAILED", "Malformed hello_proof");
      this.stream.socket.close();
      return;
    }
    if (this.state.kind !== "awaiting_proof") {
      await this.sendError("AUTH_FAILED", "Unexpected hello_proof");
      this.stream.socket.close();
      return;
    }
    const { budId, deviceSecret, nonce, hello } = this.state;
    const computed = createHmac("sha256", deviceSecret).update(nonce).digest("base64url");
    if (computed !== result.data.hmac) {
      await this.sendError("AUTH_FAILED", "Invalid proof");
      this.stream.socket.close();
      return;
    }

    const sessionId = `s_${ulid()}`;
    await db
      .update(budTable)
      .set({
        status: "online",
        lastSeenAt: new Date(),
        name: hello.name,
        os: hello.os,
        arch: hello.arch,
        version: hello.version
      })
      .where(eq(budTable.budId, budId));

    await this.sendFrame("hello_ack", {
      session_id: sessionId,
      bud_id: budId,
      heartbeat_sec: config.heartbeatSec
    });

    this.state = {
      kind: "connected",
      budId,
      sessionId,
      hello
    };
    this.registerSession(budId, sessionId);
  }

  private async handleHeartbeat(ts: number) {
    if (this.state.kind !== "connected") {
      return;
    }
    const now = Date.now();
    const session = sessions.get(this.state.budId);
    if (session) {
      session.lastHeartbeat = ts;
      this.scheduleTimeout(session);
    }
    if (now - this.lastPresenceWrite > 5_000) {
      this.lastPresenceWrite = now;
      await db
        .update(budTable)
        .set({ lastSeenAt: new Date() })
        .where(eq(budTable.budId, this.state.budId));
    }
  }

  private registerSession(budId: string, sessionId: string) {
    const tracker: SessionTracker = {
      budId,
      sessionId,
      lastHeartbeat: Date.now(),
      socket: this.stream.socket
    };
    sessions.set(budId, tracker);
    this.scheduleTimeout(tracker);
  }

  private scheduleTimeout(tracker: SessionTracker) {
    if (tracker.timeout) {
      clearTimeout(tracker.timeout);
    }
    tracker.timeout = setTimeout(() => {
      sessions.delete(tracker.budId);
      void markBudOffline(tracker.budId, this.server);
      try {
        this.stream.socket.close();
      } catch {
        /* noop */
      }
    }, config.offlineGraceSec * 1000);
  }

  private async handleClose() {
    if (this.state.kind === "connected") {
      sessions.delete(this.state.budId);
      await markBudOffline(this.state.budId, this.server);
    }
    this.state = { kind: "closed" };
  }

  private async sendError(code: string, message: string) {
    const frame = {
      proto: PROTO_VERSION,
      type: "error",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      code,
      message
    } satisfies z.infer<typeof ErrorFrameSchema>;
    await this.send(frame);
  }

  private async sendFrame(type: string, payload: Record<string, unknown>) {
    const frame = {
      proto: PROTO_VERSION,
      type,
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      ...payload
    };
    await this.send(frame);
  }

  private async send(frame: object) {
    if (this.stream.socket.readyState !== this.stream.socket.OPEN) {
      return;
    }
    this.stream.socket.send(JSON.stringify(frame));
  }
}

async function markBudOffline(budId: string, server: FastifyInstance) {
  await db
    .update(budTable)
    .set({ status: "offline", lastSeenAt: new Date() })
    .where(eq(budTable.budId, budId));
  server.log.info({ budId }, "Bud marked offline");
}

function hashToken(token: string) {
  return createHmac("sha256", config.enrollmentHashSecret).update(token).digest("hex");
}
