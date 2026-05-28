import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { messageTable, terminalSessionInputLogTable } from "../db/schema.js";
import type { TerminalSession } from "../runtime/terminal-session-manager.js";
import type { ReadinessAssessment } from "./types.js";

const VISIBILITY_SCHEMA = "terminal_visibility_v1";

export type TerminalFreshnessReason =
  | "new_output"
  | "human_input"
  | "status_changed"
  | "cwd_changed"
  | "unknown_watermark";

export type TerminalFreshnessState = "clean" | "may_have_changed" | "unknown";

export type TerminalVisibilitySource = "terminal_send" | "terminal_observe";

export type TerminalVisibilityMetadata = {
  schema: typeof VISIBILITY_SCHEMA;
  session_id: string;
  observed_output_log_bytes: number | null;
  observed_cwd: string | null;
  observed_readiness_version: string | null;
  observed_at: string;
  source: TerminalVisibilitySource;
};

export type TerminalFreshnessSnapshot = {
  sessionId: string;
  state: TerminalFreshnessState;
  reasons: TerminalFreshnessReason[];
  latestVisibility: TerminalVisibilityMetadata | null;
  current: {
    outputLogBytes: number | null;
    cwd: string | null;
    readinessVersion: string | null;
  };
  latestHumanInputAt: string | null;
};

export const TERMINAL_FRESHNESS_HINT =
  "Terminal state may have changed since the last terminal tool result visible in this conversation. " +
  "If the user's request depends on current terminal output, prompt, readiness, or working directory, call terminal.observe before making assumptions.";

export const TERMINAL_HUMAN_INPUT_FRESHNESS_HINT =
  "The user may have typed in the terminal since the last terminal tool result visible in this conversation. " +
  "If the user's request depends on what happened in the terminal, call terminal.observe before making assumptions.";

export function buildTerminalReadinessVersion(
  readiness: ReadinessAssessment | Record<string, unknown> | null | undefined,
): string | null {
  const record = asRecord(readiness);
  if (!record) {
    return null;
  }

  const hints = asRecord(record.hints);
  const activeHints = Object.entries(hints ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .sort();
  const confidence = typeof record.confidence === "number" ? record.confidence : 0;
  const trigger = typeof record.trigger === "string" ? record.trigger : "unknown";
  const promptType = typeof record.prompt_type === "string" ? record.prompt_type : "unknown";

  return [
    record.ready === true ? "ready" : "not_ready",
    clampConfidence(confidence).toFixed(2),
    trigger,
    promptType,
    activeHints.join(","),
  ].join("|");
}

export function buildTerminalVisibilityMetadata(args: {
  sessionId: string;
  source: TerminalVisibilitySource;
  outputLogBytes: number | null | undefined;
  cwd: string | null | undefined;
  readiness: ReadinessAssessment | Record<string, unknown> | null | undefined;
  observedAt?: Date;
}): TerminalVisibilityMetadata {
  return {
    schema: VISIBILITY_SCHEMA,
    session_id: args.sessionId,
    observed_output_log_bytes: normalizeByteOffset(args.outputLogBytes),
    observed_cwd: args.cwd ?? null,
    observed_readiness_version: buildTerminalReadinessVersion(args.readiness),
    observed_at: (args.observedAt ?? new Date()).toISOString(),
    source: args.source,
  };
}

export function buildTerminalFreshnessSnapshot(args: {
  session: TerminalSession;
  currentReadiness?: ReadinessAssessment | null;
  latestVisibility?: TerminalVisibilityMetadata | null;
  latestHumanInputAt?: Date | null;
}): TerminalFreshnessSnapshot {
  const currentOutputLogBytes = normalizeByteOffset(args.session.outputLogBytes);
  const currentCwd = args.session.cwd ?? null;
  const currentReadinessVersion = buildTerminalReadinessVersion(args.currentReadiness ?? null);
  const latestVisibility = args.latestVisibility ?? null;
  const latestHumanInputAt = args.latestHumanInputAt ?? null;
  const reasons: TerminalFreshnessReason[] = [];

  if (!latestVisibility) {
    if ((currentOutputLogBytes ?? 0) > 0) {
      reasons.push("new_output");
    }
    if (currentCwd) {
      reasons.push("cwd_changed");
    }
    if (currentReadinessVersion) {
      reasons.push("status_changed");
    }
    if (latestHumanInputAt) {
      reasons.push("human_input");
    }
    if (reasons.length > 0) {
      reasons.push("unknown_watermark");
    }
    return snapshotFor(
      args.session.sessionId,
      reasons.length > 0 ? "unknown" : "clean",
      reasons,
      latestVisibility,
      {
        outputLogBytes: currentOutputLogBytes,
        cwd: currentCwd,
        readinessVersion: currentReadinessVersion,
        latestHumanInputAt,
      },
    );
  }

  if (latestVisibility.observed_output_log_bytes === null) {
    reasons.push("unknown_watermark");
  } else if (
    currentOutputLogBytes !== null &&
    currentOutputLogBytes > latestVisibility.observed_output_log_bytes
  ) {
    reasons.push("new_output");
  }

  if (currentCwd !== latestVisibility.observed_cwd) {
    reasons.push("cwd_changed");
  }

  if (currentReadinessVersion !== latestVisibility.observed_readiness_version) {
    reasons.push("status_changed");
  }

  const observedAt = parseDate(latestVisibility.observed_at);
  if (latestHumanInputAt && (!observedAt || latestHumanInputAt > observedAt)) {
    reasons.push("human_input");
  }

  return snapshotFor(
    args.session.sessionId,
    reasons.length > 0 ? "may_have_changed" : "clean",
    dedupeReasons(reasons),
    latestVisibility,
    {
      outputLogBytes: currentOutputLogBytes,
      cwd: currentCwd,
      readinessVersion: currentReadinessVersion,
      latestHumanInputAt,
    },
  );
}

export async function resolveTerminalFreshness(args: {
  threadId: string;
  session: TerminalSession | null;
  currentReadiness?: ReadinessAssessment | null;
}): Promise<TerminalFreshnessSnapshot | null> {
  if (!args.session) {
    return null;
  }

  const [latestVisibility, latestHumanInputAt] = await Promise.all([
    loadLatestTerminalVisibility(args.threadId, args.session.sessionId),
    loadLatestHumanInputAt(args.session.sessionId),
  ]);

  return buildTerminalFreshnessSnapshot({
    session: args.session,
    currentReadiness: args.currentReadiness ?? null,
    latestVisibility,
    latestHumanInputAt,
  });
}

export async function loadLatestTerminalVisibility(
  threadId: string,
  sessionId: string,
): Promise<TerminalVisibilityMetadata | null> {
  const rows = await db
    .select({
      metadata: messageTable.metadata,
    })
    .from(messageTable)
    .where(and(eq(messageTable.threadId, threadId), eq(messageTable.role, "tool")))
    .orderBy(desc(messageTable.createdAt), desc(messageTable.messageId))
    .limit(100);

  for (const row of rows) {
    const visibility = parseTerminalVisibilityMetadata(row.metadata);
    if (visibility?.session_id === sessionId) {
      return visibility;
    }
  }

  return null;
}

export async function loadLatestHumanInputAt(sessionId: string): Promise<Date | null> {
  const [input] = await db
    .select({ createdAt: terminalSessionInputLogTable.createdAt })
    .from(terminalSessionInputLogTable)
    .where(
      and(
        eq(terminalSessionInputLogTable.sessionId, sessionId),
        eq(terminalSessionInputLogTable.source, "user"),
      ),
    )
    .orderBy(desc(terminalSessionInputLogTable.createdAt))
    .limit(1);

  return input?.createdAt ?? null;
}

export function buildTerminalFreshnessInstruction(
  snapshot: TerminalFreshnessSnapshot | null,
): string | null {
  if (!snapshot || snapshot.state === "clean" || snapshot.reasons.length === 0) {
    return null;
  }

  return snapshot.reasons.includes("human_input")
    ? TERMINAL_HUMAN_INPUT_FRESHNESS_HINT
    : TERMINAL_FRESHNESS_HINT;
}

export function parseTerminalVisibilityMetadata(metadata: unknown): TerminalVisibilityMetadata | null {
  const container = asRecord(metadata);
  const visibility = asRecord(container?.terminal_visibility);
  if (!visibility) {
    return null;
  }

  if (visibility.schema !== VISIBILITY_SCHEMA) {
    return null;
  }
  if (typeof visibility.session_id !== "string" || visibility.session_id.length === 0) {
    return null;
  }
  if (visibility.source !== "terminal_send" && visibility.source !== "terminal_observe") {
    return null;
  }
  if (typeof visibility.observed_at !== "string" || !parseDate(visibility.observed_at)) {
    return null;
  }

  return {
    schema: VISIBILITY_SCHEMA,
    session_id: visibility.session_id,
    observed_output_log_bytes:
      typeof visibility.observed_output_log_bytes === "number" &&
      Number.isFinite(visibility.observed_output_log_bytes)
        ? Math.max(0, Math.floor(visibility.observed_output_log_bytes))
        : null,
    observed_cwd: typeof visibility.observed_cwd === "string" ? visibility.observed_cwd : null,
    observed_readiness_version:
      typeof visibility.observed_readiness_version === "string"
        ? visibility.observed_readiness_version
        : null,
    observed_at: visibility.observed_at,
    source: visibility.source,
  };
}

function snapshotFor(
  sessionId: string,
  state: TerminalFreshnessState,
  reasons: TerminalFreshnessReason[],
  latestVisibility: TerminalVisibilityMetadata | null,
  current: {
    outputLogBytes: number | null;
    cwd: string | null;
    readinessVersion: string | null;
    latestHumanInputAt: Date | null;
  },
): TerminalFreshnessSnapshot {
  return {
    sessionId,
    state,
    reasons: dedupeReasons(reasons),
    latestVisibility,
    current: {
      outputLogBytes: current.outputLogBytes,
      cwd: current.cwd,
      readinessVersion: current.readinessVersion,
    },
    latestHumanInputAt: current.latestHumanInputAt?.toISOString() ?? null,
  };
}

function dedupeReasons(reasons: TerminalFreshnessReason[]): TerminalFreshnessReason[] {
  return [...new Set(reasons)];
}

function normalizeByteOffset(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
