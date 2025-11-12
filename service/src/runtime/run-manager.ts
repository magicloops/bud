import { ulid } from "ulid";
import { db } from "../db/client.js";
import {
  runTable,
  runStepTable,
  runLogTable,
  threadTable,
  budTable
} from "../db/schema.js";
import { RunEventBus } from "./event-bus.js";
import { eq } from "drizzle-orm";
import { Buffer } from "node:buffer";
import { sendFrameToBud } from "../ws/gateway.js";
 

type RunRequest = {
  threadId: string;
  command: string;
  cwd?: string;
};

type RunContext = {
  runId: string;
  budId: string;
  stepId: string;
  seq: number;
};

const activeRuns = new Map<string, RunContext>();

export class RunManager {
  private readonly events: RunEventBus;

  constructor(events: RunEventBus) {
    this.events = events;
  }

  async createRun(request: RunRequest): Promise<{ runId: string }> {
    const thread = await db.query.threadTable.findFirst({
      where: eq(threadTable.threadId, request.threadId)
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
      status: "running",
      startedAt: now,
      createdAt: now
    });

    const [step] = await db
      .insert(runStepTable)
      .values({
        runId,
        idx: 0,
        tool: "shell.run",
        argsJson: { cmd: request.command, cwd: request.cwd ?? "~" },
        startedAt: now
      })
      .returning({
        stepId: runStepTable.stepId
      });

    const frame = {
      proto: "0.1",
      type: "run",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      run_id: runId,
      cmd: request.command,
      cwd: request.cwd ?? "~",
      env: {
        CI: "1",
        LANG: "C.UTF-8",
        GIT_ASKPASS: "/bin/true"
      },
      timeout_ms: 30 * 60 * 1000,
      use_pty: false
    };

    const sent = sendFrameToBud(thread.budId, frame);
    if (!sent) {
      await db
        .update(runTable)
        .set({ status: "failed", finishedAt: new Date(), error: "BUD_OFFLINE" })
        .where(eq(runTable.runId, runId));
      throw new Error("bud disconnected");
    }

    activeRuns.set(runId, {
      runId,
      budId: thread.budId,
      stepId: step.stepId,
      seq: 0
    });

    this.events.emit(runId, {
      event: "status",
      data: { phase: "running" }
    });
    return { runId };
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
    await db.insert(runLogTable).values({
      runId,
      seq,
      stream,
      data: buffer
    });

    this.events.emit(runId, {
      event: `exec.${stream}`,
      data: {
        seq,
        chunk: buffer.toString("utf-8")
      }
    });
  }

  async handleRunFinished(
    runId: string,
    payload: { exit_code: number | null; canceled?: boolean; signal?: string }
  ): Promise<void> {
    const context = activeRuns.get(runId);
    const finishedAt = new Date();
    await db
      .update(runTable)
      .set({
        status: payload.canceled ? "canceled" : payload.exit_code === 0 ? "succeeded" : "failed",
        finishedAt
      })
      .where(eq(runTable.runId, runId));

    if (context) {
      await db
        .update(runStepTable)
        .set({
          finishedAt,
          exitCode: payload.exit_code ?? undefined
        })
        .where(eq(runStepTable.stepId, context.stepId));
    }

    this.events.emit(runId, {
      event: "final",
      data: {
        status: payload.canceled ? "canceled" : payload.exit_code === 0 ? "succeeded" : "failed",
        exit_code: payload.exit_code,
        signal: payload.signal
      }
    });

    activeRuns.delete(runId);
  }
}
