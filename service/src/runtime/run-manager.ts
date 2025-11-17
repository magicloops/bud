import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  budTable,
  runLogTable,
  runStepTable,
  runTable,
  threadTable
} from "../db/schema.js";
import { RunEventBus } from "./event-bus.js";
import { config } from "../config.js";
import { sendFrameToBud } from "../ws/gateway.js";
import { upsertRunSummary } from "../db/run-summary.js";

type RunRequest = {
  threadId: string;
  command: string;
  cwd?: string;
};

type DispatchMode = "standalone" | "agent";

export type RunStepResult = {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  bytes: {
    stdout: number;
    stderr: number;
  };
};

type RunContext = {
  runId: string;
  budId: string;
  stepId: string;
  seq: number;
  mode: DispatchMode;
  // eslint-disable-next-line no-unused-vars
  resolve?: (result: RunStepResult) => void;
  // eslint-disable-next-line no-unused-vars
  reject?: (reason?: unknown) => void;
  stdoutTail: string;
  stderrTail: string;
  bytes: {
    stdout: number;
    stderr: number;
  };
};

const activeRuns = new Map<string, RunContext>();
const TAIL_CHAR_LIMIT = 4 * 1024;
type DispatchHandle = ReturnType<typeof createDeferred<RunStepResult>>;

function createDeferred<T>() {
  // eslint-disable-next-line no-unused-vars
  let resolve!: (value: T) => void;
  // eslint-disable-next-line no-unused-vars
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appendTail(current: string, chunk: Buffer) {
  const next = current + chunk.toString("utf-8");
  if (next.length <= TAIL_CHAR_LIMIT) {
    return next;
  }
  return next.slice(next.length - TAIL_CHAR_LIMIT);
}

export class RunManager {
  private readonly events: RunEventBus;
  private readonly logger: FastifyBaseLogger;
  private readonly debugEnabled: boolean;

  constructor(events: RunEventBus, logger: FastifyBaseLogger, debugEnabled: boolean) {
    this.events = events;
    this.logger = logger;
    this.debugEnabled = debugEnabled;
  }

  async createRun(request: RunRequest): Promise<{ runId: string }> {
    const { runId, budId } = await this.createRunRecord(request.threadId, {
      status: "running"
    });

    const dispatch = await this.dispatchShellCommand({
      runId,
      budId,
      command: request.command,
      cwd: request.cwd ?? "~",
      mode: "standalone"
    });

    dispatch.promise.catch((err) => {
      this.debug("Standalone run failed", {
        runId,
        error: err instanceof Error ? err.message : String(err)
      });
      this.events.emit(runId, {
        event: "final",
        data: {
          status: "failed",
          error: err instanceof Error ? err.message : "run failed"
        },
        id: ulid()
      });
    });

    return { runId };
  }

  async createRunRecord(
    threadId: string,
    options: { status?: "planning" | "running" } = {}
  ): Promise<{ runId: string; budId: string; threadId: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, threadId)
    });
    if (!thread) {
      throw new Error("thread not found");
    }

    const bud = await db.query.budTable.findFirst({
      where: eq(budTable.budId, thread.budId)
    });
    if (!bud) {
      throw new Error("bud not found");
    }
    if (bud.status !== "online") {
      throw new Error("bud is offline");
    }

    const runId = `run_${ulid()}`;
    const now = new Date();
    await db.insert(runTable).values({
      runId,
      threadId: thread.threadId,
      status: options.status ?? "planning",
      startedAt: now,
      createdAt: now
    });

    this.events.emit(runId, {
      event: "status",
      data: { phase: options.status ?? "planning" },
      id: ulid()
    });

    return { runId, budId: bud.budId, threadId: thread.threadId };
  }

  async dispatchShellCommand(params: {
    runId: string;
    budId: string;
    command: string;
    cwd: string;
    mode: DispatchMode;
  }): Promise<DispatchHandle> {
    const now = new Date();
    const previousStep = await db.query.runStepTable.findFirst({
      where: eq(runStepTable.runId, params.runId),
      columns: { idx: runStepTable.idx },
      orderBy: desc(runStepTable.idx)
    });
    const idx = previousStep?.idx != null ? previousStep.idx + 1 : 0;

    const [step] = await db
      .insert(runStepTable)
      .values({
        runId: params.runId,
        idx,
        tool: "shell.run",
        argsJson: { cmd: params.command, cwd: params.cwd },
        startedAt: now
      })
      .returning({
        stepId: runStepTable.stepId
      });

    await db
      .update(runTable)
      .set({ status: "running", stepCount: idx + 1 })
      .where(eq(runTable.runId, params.runId));

    this.events.emit(params.runId, {
      event: "status",
      data: { phase: "running" },
      id: ulid()
    });

    const frame = {
      proto: "0.1",
      type: "run",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      run_id: params.runId,
      cmd: params.command,
      cwd: params.cwd,
      env: {
        CI: "1",
        LANG: "C.UTF-8",
        GIT_ASKPASS: "/bin/true"
      },
      timeout_ms: 30 * 60 * 1000,
      use_pty: false
    };

    this.debug("Dispatching run to Bud", {
      runId: params.runId,
      budId: params.budId,
      command: params.command,
      cwd: params.cwd,
      mode: params.mode
    });

    const sent = sendFrameToBud(params.budId, frame);
    if (!sent) {
      this.debug("Failed to send run frame to Bud", {
        runId: params.runId,
        budId: params.budId
      });
      await db
        .update(runTable)
        .set({ status: "failed", finishedAt: new Date(), error: "BUD_OFFLINE" })
        .where(eq(runTable.runId, params.runId));
      await upsertRunSummary({
        runId: params.runId,
        status: "failed",
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        finishedAt: new Date()
      });
      throw new Error("bud disconnected");
    }

    const deferred = createDeferred<RunStepResult>();
    activeRuns.set(params.runId, {
      runId: params.runId,
      budId: params.budId,
      stepId: step.stepId,
      seq: 0,
      mode: params.mode,
      resolve: deferred.resolve,
      reject: deferred.reject,
      stdoutTail: "",
      stderrTail: "",
      bytes: { stdout: 0, stderr: 0 }
    });

    this.debug("Run registered with active tracker", {
      runId: params.runId,
      stepId: step.stepId,
      mode: params.mode
    });

    return deferred;
  }

  async handleStreamChunk(
    runId: string,
    stream: "stdout" | "stderr",
    dataB64: string,
    seq: number
  ): Promise<void> {
    const context = activeRuns.get(runId);
    if (!context) {
      return;
    }
    const buffer = Buffer.from(dataB64, "base64");
    const runRow = await db.query.runTable.findFirst({
      where: eq(runTable.runId, runId),
      columns: { logsBytes: runTable.logsBytes, logTruncated: runTable.logTruncated }
    });

    if (runRow?.logTruncated) {
      // no-op; still stream to SSE listeners
    } else {
      const currentBytes = runRow?.logsBytes ?? 0;
      const remaining = Math.max(config.runLogMaxBytes - currentBytes, 0);
      const toStore = remaining >= buffer.length ? buffer : buffer.subarray(0, remaining);
      if (toStore.length > 0) {
        await db.insert(runLogTable).values({
          runId,
          seq,
          stream,
          data: toStore
        });
      }
      const newTotal = currentBytes + buffer.length;
      await db
        .update(runTable)
        .set({
          logsBytes: Math.min(newTotal, config.runLogMaxBytes),
          logTruncated: newTotal > config.runLogMaxBytes
        })
        .where(eq(runTable.runId, runId));
    }

    if (stream === "stdout") {
      context.stdoutTail = appendTail(context.stdoutTail, buffer);
      context.bytes.stdout += buffer.length;
    } else {
      context.stderrTail = appendTail(context.stderrTail, buffer);
      context.bytes.stderr += buffer.length;
    }

    this.debug("Streaming chunk received", {
      runId,
      stream,
      seq,
      bytes: buffer.length
    });

    this.events.emit(runId, {
      event: `exec.${stream}`,
      data: {
        seq,
        chunk: buffer.toString("utf-8")
      },
      id: ulid()
    });
  }

  async handleRunFinished(
    runId: string,
    payload: { exit_code: number | null; canceled?: boolean; signal?: string | null }
  ): Promise<void> {
    const context = activeRuns.get(runId);
    const finishedAt = new Date();

    if (context) {
      await db
        .update(runStepTable)
        .set({
          finishedAt,
          exitCode: payload.exit_code ?? undefined
        })
        .where(eq(runStepTable.stepId, context.stepId));
    }

    const resolvedStatus = payload.canceled
      ? "canceled"
      : payload.exit_code === 0
        ? "succeeded"
        : "failed";

    if (!context || context.mode === "standalone") {
      await db
        .update(runTable)
        .set({
          status: resolvedStatus,
          finishedAt
        })
        .where(eq(runTable.runId, runId));

      await upsertRunSummary({
        runId,
        status: resolvedStatus,
        exitCode: payload.exit_code ?? null,
        stdoutBytes: context?.bytes.stdout ?? 0,
        stderrBytes: context?.bytes.stderr ?? 0,
        finishedAt
      });

      this.events.emit(runId, {
        event: "final",
        data: {
          status: resolvedStatus,
          exit_code: payload.exit_code,
          signal: payload.signal
        },
        id: ulid()
      });
    } else {
      context.resolve?.({
        exitCode: payload.exit_code ?? null,
        signal: payload.signal ?? undefined,
        stdout: context.stdoutTail,
        stderr: context.stderrTail,
        bytes: context.bytes
      });
    }

    this.debug("Run finished", {
      runId,
      mode: context?.mode ?? "standalone",
      exit_code: payload.exit_code,
      canceled: payload.canceled,
      signal: payload.signal
    });

    activeRuns.delete(runId);
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    if (!this.debugEnabled) {
      return;
    }
    this.logger.info({ ...meta, component: "run_manager" }, message);
  }
}
