import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalCommandStore,
  type TerminalCommandPersistence,
  type TerminalCommandRecord,
} from "./terminal-command-store.js";
import type { TerminalSession } from "./session-types.js";

class InMemoryCommandPersistence implements TerminalCommandPersistence {
  readonly rows = new Map<string, TerminalCommandRecord>();

  async insertCommand(row: TerminalCommandRecord): Promise<boolean> {
    if (this.rows.has(row.commandId)) {
      return false;
    }
    this.rows.set(row.commandId, { ...row });
    return true;
  }

  async finalizeCommand(
    commandId: string,
    args: {
      commandFinishedAt: Date;
      exitCode: number | null;
      outputByteEnd: number | null;
      outputByteStart: number | null;
    },
  ): Promise<boolean> {
    const existing = this.rows.get(commandId);
    if (!existing) {
      return false;
    }
    existing.commandFinishedAt = args.commandFinishedAt;
    existing.exitCode = args.exitCode;
    existing.outputByteEnd = args.outputByteEnd;
    if (args.outputByteStart !== null) {
      existing.outputByteStart = args.outputByteStart;
    }
    return true;
  }

  async getCommand(commandId: string): Promise<TerminalCommandRecord | null> {
    const row = this.rows.get(commandId);
    return row ? { ...row } : null;
  }

  async getLatestCommandForSession(sessionId: string): Promise<TerminalCommandRecord | null> {
    const candidates = [...this.rows.values()].filter(
      (row) => row.terminalSessionId === sessionId,
    );
    candidates.sort((a, b) => {
      const byStartedAt = b.commandStartedAt.getTime() - a.commandStartedAt.getTime();
      if (byStartedAt !== 0) {
        return byStartedAt;
      }
      return b.commandId.localeCompare(a.commandId);
    });
    const latest = candidates[0];
    return latest ? { ...latest } : null;
  }
}

function createLogger() {
  return {
    info() {
      // noop
    },
    warn() {
      // noop
    },
    error() {
      // noop
    },
  } as never;
}

function createSession(): TerminalSession {
  return {
    sessionId: "sess_test",
    threadId: "thread-1",
    budId: "bud-1",
    instanceId: null,
    state: "active",
    cols: 200,
    rows: 50,
    cwd: null,
    createdAt: new Date("2026-05-01T19:00:00.000Z"),
    startedAt: null,
    lastActivityAt: null,
    outputLogBytes: 0,
    createdByUserId: "user-1",
    tenantId: "tenant-1",
  };
}

test("command_started then command_finished produces a complete owner-stamped row", async () => {
  const persistence = new InMemoryCommandPersistence();
  const store = new TerminalCommandStore(createLogger(), persistence);
  const session = createSession();

  await store.recordCommandStarted(session, {
    commandId: "cmd_1",
    outputByteStart: 16384,
    ts: 1_700_000_000_000,
  });
  await store.recordCommandFinished(session, {
    commandId: "cmd_1",
    exitCode: 1,
    durationMs: 2311,
    outputByteStart: 16384,
    outputByteEnd: 18101,
    ts: 1_700_000_002_311,
  });

  const row = await store.getCommand("cmd_1");
  assert.ok(row);
  assert.equal(row.terminalSessionId, "sess_test");
  assert.equal(row.threadId, "thread-1");
  assert.equal(row.budId, "bud-1");
  assert.equal(row.createdByUserId, "user-1");
  assert.equal(row.tenantId, "tenant-1");
  assert.equal(row.commandStartedAt.getTime(), 1_700_000_000_000);
  assert.equal(row.commandFinishedAt?.getTime(), 1_700_000_002_311);
  assert.equal(row.exitCode, 1);
  assert.equal(row.outputByteStart, 16384);
  assert.equal(row.outputByteEnd, 18101);
});

test("command_started redelivery is idempotent on command_id", async () => {
  const persistence = new InMemoryCommandPersistence();
  const store = new TerminalCommandStore(createLogger(), persistence);
  const session = createSession();

  await store.recordCommandStarted(session, {
    commandId: "cmd_dup",
    outputByteStart: 0,
    ts: 1_700_000_000_000,
  });
  await store.recordCommandStarted(session, {
    commandId: "cmd_dup",
    outputByteStart: 999,
    ts: 1_700_000_009_999,
  });

  const row = await store.getCommand("cmd_dup");
  assert.equal(row?.outputByteStart, 0);
  assert.equal(row?.commandStartedAt.getTime(), 1_700_000_000_000);
  assert.equal(persistence.rows.size, 1);
});

test("command_finished without a preceding start inserts a complete row (started derived from duration)", async () => {
  const persistence = new InMemoryCommandPersistence();
  const store = new TerminalCommandStore(createLogger(), persistence);
  const session = createSession();

  await store.recordCommandFinished(session, {
    commandId: "cmd_orphan",
    exitCode: 0,
    durationMs: 5_000,
    outputByteStart: 100,
    outputByteEnd: 240,
    ts: 1_700_000_010_000,
  });

  const row = await store.getCommand("cmd_orphan");
  assert.ok(row);
  assert.equal(row.commandStartedAt.getTime(), 1_700_000_005_000);
  assert.equal(row.commandFinishedAt?.getTime(), 1_700_000_010_000);
  assert.equal(row.exitCode, 0);
  assert.equal(row.outputByteStart, 100);
  assert.equal(row.outputByteEnd, 240);
  assert.equal(row.createdByUserId, "user-1");
});

test("command_finished redelivery is idempotent", async () => {
  const persistence = new InMemoryCommandPersistence();
  const store = new TerminalCommandStore(createLogger(), persistence);
  const session = createSession();

  await store.recordCommandStarted(session, {
    commandId: "cmd_2",
    outputByteStart: 0,
    ts: 1_700_000_000_000,
  });
  for (let index = 0; index < 2; index += 1) {
    await store.recordCommandFinished(session, {
      commandId: "cmd_2",
      exitCode: 0,
      durationMs: 100,
      outputByteStart: 0,
      outputByteEnd: 64,
      ts: 1_700_000_000_100,
    });
  }

  const row = await store.getCommand("cmd_2");
  assert.equal(row?.exitCode, 0);
  assert.equal(row?.outputByteEnd, 64);
  assert.equal(persistence.rows.size, 1);
});

test("getLatestCommandForSession returns the most recent command by started_at", async () => {
  const persistence = new InMemoryCommandPersistence();
  const store = new TerminalCommandStore(createLogger(), persistence);
  const session = createSession();

  await store.recordCommandStarted(session, {
    commandId: "cmd_old",
    outputByteStart: 0,
    ts: 1_700_000_000_000,
  });
  await store.recordCommandFinished(session, {
    commandId: "cmd_old",
    exitCode: 0,
    durationMs: 50,
    outputByteStart: 0,
    outputByteEnd: 10,
    ts: 1_700_000_000_050,
  });
  await store.recordCommandStarted(session, {
    commandId: "cmd_new",
    outputByteStart: 10,
    ts: 1_700_000_100_000,
  });

  const latest = await store.getLatestCommandForSession("sess_test");
  assert.equal(latest?.commandId, "cmd_new");
  assert.equal(latest?.commandFinishedAt, null);

  assert.equal(await store.getLatestCommandForSession("sess_other"), null);
});
