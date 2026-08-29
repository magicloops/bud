import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { TERMINAL_PROTO_VERSION } from "../../config.js";
import type {
  TerminalEventOutcome,
  TerminalIntegration,
  TerminalMode,
  TerminalObservationView,
  TerminalSendAwait,
} from "../../terminal/types.js";
import { normalizeTerminalSendKeyName } from "../../terminal/types.js";
import type { TerminalSession } from "./session-types.js";

type ObserveDebugState = {
  sessionId: string;
  requestId: string;
  view: TerminalObservationView;
  lines: number;
  timeoutMs: number;
  startedAt: number;
  deadlineAt: number;
  startOffset: number;
  latestOffset: number;
  outputSeen: boolean;
  outputEventCount: number;
  timedOutAt?: number;
};

type SendDebugState = {
  sessionId: string;
  requestId: string;
  await: TerminalSendAwait | null;
  timeoutMs: number;
  startedAt: number;
  deadlineAt: number;
  startOffset: number;
  latestOffset: number;
  outputSeen: boolean;
  outputEventCount: number;
  hasText: boolean;
  submit: boolean;
  hasKey: boolean;
  timedOutAt?: number;
};

/**
 * Service-owned timeout budget for awaited sends (`await: "command" | "settled"`):
 * proto 0.3 removed `timeout_ms` from the wire, so the local pending-request
 * timer is the only budget.
 */
// Awaited-send budget: long enough for ordinary commands, short enough that a
// genuinely long-running command surfaces as an actionable still-running
// result (with command_id + observe guidance) instead of a silently pending
// agent turn — the §A codex incident hung a turn for the old one-hour budget.
export const TERMINAL_AWAITED_SEND_TIMEOUT_MS = 2 * 60 * 1000;
export const TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
/**
 * Awaited-observe budget (`terminal.wait`): deliberately long. The model
 * asked to wait for a fact and pays one provider call per wake, so a short
 * budget only converts waiting into polling. The turn stays cancellable and
 * a follow-up user message supersedes the wait at any time; the daemon's 4h
 * safety cap bounds leaks.
 */
export const TERMINAL_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export function resolveTerminalSendTimeout(
  awaitMode: TerminalSendAwait | undefined,
  requestedTimeoutMs?: number | null,
): number {
  if (
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs > 0
  ) {
    return Math.floor(requestedTimeoutMs);
  }
  return awaitMode ? TERMINAL_AWAITED_SEND_TIMEOUT_MS : TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS;
}

export type ObserveOptions = {
  lines?: number;
  view?: TerminalObservationView;
  /** Awaited observe: block on the fact before snapshotting (proto §6.1). */
  await?: TerminalSendAwait;
  /** `await:"settled"`: required quiet window in ms (daemon default when omitted). */
  quietMs?: number;
};

export type ObserveResult = {
  view: TerminalObservationView;
  output: string;
  linesCaptured: number;
  changed?: boolean;
  mode?: TerminalMode;
  integration?: TerminalIntegration;
  altScreen?: boolean;
  cursorRow?: number;
  cursorCol?: number;
  /**
   * Stream watermark the daemon's emulator reflected when this observation was
   * taken (the next output byte offset). Lets snapshot consumers resume the
   * terminal SSE stream from exactly this offset without duplication.
   */
  ringNextOffset?: number;
  outputAnsi?: string;
  /** Awaited observes: the terminating fact `{ event, data }` (proto §6.6). */
  outcome?: TerminalEventOutcome | null;
};

export type ObserveResponsePayload = {
  requestId: string;
  view: TerminalObservationView;
  output: string; // base64
  linesCaptured: number;
  changed?: boolean | null;
  mode?: TerminalMode;
  integration?: TerminalIntegration;
  altScreen?: boolean;
  cursorRow?: number;
  cursorCol?: number;
  ringNextOffset?: number;
  outputAnsi?: string;
  outcome?: TerminalEventOutcome | null;
  error: string | null;
};

export type SendInteraction = {
  text?: string;
  submit?: boolean;
  key?: string;
  await?: TerminalSendAwait;
};

/** Daemon-resolved facts riding on a send result (proto §6.7.4). */
export type SendResultFacts = {
  /** How an `await:"auto"` resolved: `command` at a prompt, else `settled`. */
  resolvedAwait?: "command" | "settled" | "auto";
  /** Input gate: ms spent waiting for the open program to be ready
   * (painted + quiet) before typing. Absent when nothing was open. */
  gatedMs?: number;
  /** Input gate outcome: false when the readiness cap expired and the bytes
   * were typed anyway. */
  programReady?: boolean;
};

export type SendResult = SendResultFacts & {
  dispatched: boolean;
  outcome: TerminalEventOutcome | null;
};

export type SendResultPayload = SendResultFacts & {
  requestId: string;
  dispatched: boolean;
  outcome: TerminalEventOutcome | null;
  error: string | null;
};

type PendingObserve = {
  resolve: (result: ObserveResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  state: ObserveDebugState;
};

type PendingSend = {
  sessionId: string;
  resolve: (result: SendResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  state: SendDebugState;
};

type TerminalRequestDispatcherDeps = {
  logger: FastifyBaseLogger;
  getSession: (sessionId: string) => Promise<TerminalSession | null>;
  getLastOffset: (sessionId: string) => number;
  sendFrameToBud: (budId: string, payload: Record<string, unknown>) => boolean;
  summarizeObservedOutput: (output: string) => Record<string, unknown>;
};

export class TerminalRequestDispatcher {
  private readonly deps: TerminalRequestDispatcherDeps;
  private readonly pendingObserves = new Map<string, PendingObserve>();
  private readonly pendingSends = new Map<string, PendingSend>();
  private readonly recentObserveStates = new Map<string, ObserveDebugState>();
  private readonly recentSendStates = new Map<string, SendDebugState>();

  constructor(deps: TerminalRequestDispatcherDeps) {
    this.deps = deps;
  }

  async observeTerminal(
    sessionId: string,
    options: ObserveOptions = {},
    requestedTimeoutMs?: number
  ): Promise<ObserveResult> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `obs_${ulid()}`;
    const view = options.view ?? "screen";
    const lines = options.lines ?? -50;
    const awaitMode = options.await;
    const quietMs =
      typeof options.quietMs === "number" && Number.isFinite(options.quietMs) && options.quietMs > 0
        ? Math.floor(options.quietMs)
        : undefined;
    const timeoutMs =
      typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? Math.floor(requestedTimeoutMs)
        : awaitMode
          ? TERMINAL_WAIT_TIMEOUT_MS
          : TERMINAL_DEFAULT_REQUEST_TIMEOUT_MS;
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    const startOffset = this.deps.getLastOffset(sessionId);
    const observeState: ObserveDebugState = {
      sessionId,
      requestId,
      view,
      lines,
      timeoutMs,
      startedAt,
      deadlineAt,
      startOffset,
      latestOffset: startOffset,
      outputSeen: false,
      outputEventCount: 0
    };

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_observe",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      view,
      lines,
      ...(awaitMode ? { await: awaitMode } : {}),
      ...(awaitMode === "settled" && quietMs !== undefined ? { quiet_ms: quietMs } : {}),
    };

    const sent = this.deps.sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.pruneRecentObserveStates(startedAt);
    this.recentObserveStates.set(requestId, observeState);

    this.deps.logger.info(
      {
        sessionId,
        requestId,
        view,
        lines,
        ...(awaitMode ? { await: awaitMode, quietMs: quietMs ?? null } : {}),
        timeoutMs,
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(deadlineAt).toISOString(),
        startOffset,
        component: "terminal_request_dispatcher"
      },
      "Sending terminal_observe request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingObserves.get(requestId);
        if (!pending) {
          return;
        }
        const timedOutAt = Date.now();
        pending.state.timedOutAt = timedOutAt;
        pending.state.latestOffset = this.deps.getLastOffset(sessionId);
        this.pendingObserves.delete(requestId);
        this.deps.logger.warn(
          {
            sessionId,
            requestId,
            timeoutMs: pending.state.timeoutMs,
            ageMs: timedOutAt - pending.state.startedAt,
            deadlineAt: new Date(pending.state.deadlineAt).toISOString(),
            startOffset: pending.state.startOffset,
            latestOffset: pending.state.latestOffset,
            outputSeen: pending.state.outputSeen,
            outputEventCount: pending.state.outputEventCount,
            offsetDelta: Math.max(pending.state.latestOffset - pending.state.startOffset, 0),
            component: "terminal_request_dispatcher"
          },
          "terminal_observe timed out locally"
        );
        reject(new Error("observe_timeout"));
      }, timeoutMs);

      this.pendingObserves.set(requestId, { resolve, reject, timeout, state: observeState });
    });
  }

  async sendInteraction(
    sessionId: string,
    interaction: SendInteraction,
    options: {
      timeoutMs?: number;
      rejectPendingRequestsWith?: string;
      onPendingRequestsRejected?: (count: number) => void;
    } = {}
  ): Promise<SendResult> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `send_${ulid()}`;
    const awaitMode = interaction.await;
    const timeoutMs = resolveTerminalSendTimeout(awaitMode, options.timeoutMs);
    const key = interaction.key?.trim() ? normalizeTerminalSendKeyName(interaction.key) : undefined;
    const hasTextField = typeof interaction.text === "string";
    const hasTextPayload = typeof interaction.text === "string" && interaction.text.length > 0;

    if (interaction.submit === true && !hasTextField) {
      throw new Error("submit_requires_text");
    }
    if (key && (hasTextField || interaction.submit === true)) {
      throw new Error("ambiguous_interaction");
    }
    if (!hasTextPayload && interaction.submit !== true && !key) {
      throw new Error("empty_interaction");
    }

    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    const startOffset = this.deps.getLastOffset(sessionId);
    const sendState: SendDebugState = {
      sessionId,
      requestId,
      await: awaitMode ?? null,
      timeoutMs,
      startedAt,
      deadlineAt,
      startOffset,
      latestOffset: startOffset,
      outputSeen: false,
      outputEventCount: 0,
      hasText: hasTextField,
      submit: interaction.submit === true,
      hasKey: Boolean(key)
    };

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_send",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      ...(hasTextField ? { text: interaction.text, submit: interaction.submit === true } : {}),
      ...(key ? { key } : {}),
      ...(awaitMode ? { await: awaitMode } : {}),
    };

    const sent = this.deps.sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.pruneRecentSendStates(startedAt);
    this.recentSendStates.set(requestId, sendState);

    this.deps.logger.info(
      {
        sessionId,
        requestId,
        hasText: sendState.hasText,
        submit: sendState.submit,
        hasKey: sendState.hasKey,
        await: awaitMode ?? null,
        timeoutMs,
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(deadlineAt).toISOString(),
        startOffset,
        component: "terminal_request_dispatcher"
      },
      "Sending terminal_send request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingSends.get(requestId);
        if (!pending) {
          return;
        }
        const timedOutAt = Date.now();
        pending.state.timedOutAt = timedOutAt;
        pending.state.latestOffset = this.deps.getLastOffset(sessionId);
        this.pendingSends.delete(requestId);
        this.deps.logger.warn(
          {
            sessionId,
            requestId,
            await: pending.state.await,
            timeoutMs: pending.state.timeoutMs,
            elapsedMs: timedOutAt - pending.state.startedAt,
            deadlineAt: new Date(pending.state.deadlineAt).toISOString(),
            startOffset: pending.state.startOffset,
            latestOffset: pending.state.latestOffset,
            outputSeen: pending.state.outputSeen,
            outputEventCount: pending.state.outputEventCount,
            offsetDelta: Math.max(pending.state.latestOffset - pending.state.startOffset, 0),
            component: "terminal_request_dispatcher"
          },
          "terminal_send timed out locally"
        );
        reject(new Error("send_timeout"));
      }, timeoutMs);

      this.pendingSends.set(requestId, { sessionId, resolve, reject, timeout, state: sendState });

      if (options.rejectPendingRequestsWith) {
        const rejected = this.rejectPendingRequestsForSession(
          sessionId,
          options.rejectPendingRequestsWith,
          { exceptRequestId: requestId },
        );
        options.onPendingRequestsRejected?.(rejected);
      }
    });
  }

  noteOutputObserved(
    sessionId: string,
    details: { requestOffset: number; endOffset: number; outputBytes: number }
  ): void {
    const observeRequestsSeeingOutput: string[] = [];
    for (const pending of this.pendingObserves.values()) {
      if (pending.state.sessionId !== sessionId) {
        continue;
      }
      pending.state.outputSeen = true;
      pending.state.outputEventCount += 1;
      pending.state.latestOffset = Math.max(pending.state.latestOffset, details.endOffset);
      observeRequestsSeeingOutput.push(pending.state.requestId);
    }

    const sendRequestsSeeingOutput: string[] = [];
    for (const pending of this.pendingSends.values()) {
      if (pending.state.sessionId !== sessionId) {
        continue;
      }
      pending.state.outputSeen = true;
      pending.state.outputEventCount += 1;
      pending.state.latestOffset = Math.max(pending.state.latestOffset, details.endOffset);
      sendRequestsSeeingOutput.push(pending.state.requestId);
    }

    if (observeRequestsSeeingOutput.length > 0 || sendRequestsSeeingOutput.length > 0) {
      this.debug("terminal output arrived while terminal requests were pending", {
        sessionId,
        observeRequestIds: observeRequestsSeeingOutput,
        sendRequestIds: sendRequestsSeeingOutput,
        byteOffset: details.requestOffset,
        endOffset: details.endOffset,
        outputBytes: details.outputBytes
      });
    }
  }

  async handleObserveResult(sessionId: string, payload: ObserveResponsePayload): Promise<void> {
    const pending = this.pendingObserves.get(payload.requestId);
    const observeState = this.recentObserveStates.get(payload.requestId) ?? pending?.state;
    const output = Buffer.from(payload.output, "base64").toString("utf-8");
    const outputSummary = this.deps.summarizeObservedOutput(output);
    const latencyMs = observeState ? Date.now() - observeState.startedAt : undefined;

    if (!pending) {
      if (observeState?.timedOutAt) {
        this.deps.logger.warn(
          {
            sessionId,
            requestId: payload.requestId,
            timeoutMs: observeState.timeoutMs,
            latencyMs,
            lateByMs: Date.now() - observeState.timedOutAt,
            linesCaptured: payload.linesCaptured,
            outputSummary,
            component: "terminal_request_dispatcher"
          },
          "Observe result arrived after local timeout"
        );
        this.recentObserveStates.delete(payload.requestId);
        return;
      }
      this.deps.logger.warn(
        {
          sessionId,
          requestId: payload.requestId,
          linesCaptured: payload.linesCaptured,
          outputSummary,
          component: "terminal_request_dispatcher"
        },
        "Orphaned observe result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingObserves.delete(payload.requestId);
    this.recentObserveStates.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    this.deps.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        view: payload.view,
        timeoutMs: observeState?.timeoutMs,
        latencyMs,
        linesCaptured: payload.linesCaptured,
        mode: payload.mode ?? null,
        integration: payload.integration ?? null,
        altScreen: payload.altScreen ?? null,
        outputSeenDuringWait: observeState?.outputSeen ?? false,
        outputEventCount: observeState?.outputEventCount ?? 0,
        outputOffsetDelta: observeState
          ? Math.max(observeState.latestOffset - observeState.startOffset, 0)
          : 0,
        outputSummary,
        component: "terminal_request_dispatcher"
      },
      "Observe result received"
    );

    pending.resolve({
      view: payload.view,
      output,
      linesCaptured: payload.linesCaptured,
      changed: typeof payload.changed === "boolean" ? payload.changed : undefined,
      ...(payload.mode ? { mode: payload.mode } : {}),
      ...(payload.integration ? { integration: payload.integration } : {}),
      ...(typeof payload.altScreen === "boolean" ? { altScreen: payload.altScreen } : {}),
      ...(typeof payload.cursorRow === "number" ? { cursorRow: payload.cursorRow } : {}),
      ...(typeof payload.cursorCol === "number" ? { cursorCol: payload.cursorCol } : {}),
      ...(typeof payload.ringNextOffset === "number" ? { ringNextOffset: payload.ringNextOffset } : {}),
      ...(typeof payload.outputAnsi === "string"
        ? { outputAnsi: Buffer.from(payload.outputAnsi, "base64").toString("utf-8") }
        : {}),
      ...(payload.outcome ? { outcome: payload.outcome } : {}),
    });
  }

  async handleSendResult(sessionId: string, payload: SendResultPayload): Promise<void> {
    const pending = this.pendingSends.get(payload.requestId);
    const sendState = this.recentSendStates.get(payload.requestId) ?? pending?.state;
    const latencyMs = sendState ? Date.now() - sendState.startedAt : undefined;
    if (!pending) {
      if (sendState?.timedOutAt) {
        this.deps.logger.warn(
          {
            sessionId,
            requestId: payload.requestId,
            await: sendState.await,
            timeoutMs: sendState.timeoutMs,
            latencyMs,
            lateByMs: Date.now() - sendState.timedOutAt,
            dispatched: payload.dispatched,
            outcome: payload.outcome,
            outputSeenDuringWait: sendState.outputSeen,
            outputEventCount: sendState.outputEventCount,
            outputOffsetDelta: Math.max(sendState.latestOffset - sendState.startOffset, 0),
            component: "terminal_request_dispatcher"
          },
          "Send result arrived after local timeout"
        );
        this.recentSendStates.delete(payload.requestId);
        return;
      }
      this.deps.logger.warn(
        { sessionId, requestId: payload.requestId, component: "terminal_request_dispatcher" },
        "Orphaned send result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingSends.delete(payload.requestId);
    this.recentSendStates.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    this.deps.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        dispatched: payload.dispatched,
        await: sendState?.await,
        timeoutMs: sendState?.timeoutMs,
        latencyMs,
        outcomeEvent: payload.outcome?.event ?? null,
        outputSeenDuringWait: sendState?.outputSeen ?? false,
        outputEventCount: sendState?.outputEventCount ?? 0,
        outputOffsetDelta: sendState
          ? Math.max(sendState.latestOffset - sendState.startOffset, 0)
          : 0,
        component: "terminal_request_dispatcher"
      },
      "Send result received"
    );

    pending.resolve({
      dispatched: payload.dispatched,
      outcome: payload.outcome ?? null,
      ...(payload.resolvedAwait !== undefined ? { resolvedAwait: payload.resolvedAwait } : {}),
      ...(typeof payload.gatedMs === "number" ? { gatedMs: payload.gatedMs } : {}),
      ...(typeof payload.programReady === "boolean" ? { programReady: payload.programReady } : {}),
    });
  }

  rejectPendingRequestsForSession(
    sessionId: string,
    errorMessage: string,
    options: { exceptRequestId?: string } = {},
  ): number {
    let rejected = 0;

    for (const [requestId, pending] of this.pendingObserves.entries()) {
      if (requestId === options.exceptRequestId) {
        continue;
      }
      if (pending.state.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingObserves.delete(requestId);
      this.recentObserveStates.delete(requestId);
      this.logPendingObserveRejected(pending.state, errorMessage);
      pending.reject(new Error(errorMessage));
      rejected += 1;
    }

    for (const [requestId, pending] of this.pendingSends.entries()) {
      if (requestId === options.exceptRequestId) {
        continue;
      }
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingSends.delete(requestId);
      this.recentSendStates.delete(requestId);
      this.logPendingSendRejected(pending.state, errorMessage);
      pending.reject(new Error(errorMessage));
      rejected += 1;
    }

    if (rejected > 0) {
      this.deps.logger.warn(
        { sessionId, rejected, errorMessage, component: "terminal_request_dispatcher" },
        "Rejected pending terminal requests"
      );
    }

    return rejected;
  }

  rejectPendingRequestsForSessions(sessionIds: readonly string[], errorMessage: string): number {
    let rejected = 0;
    for (const sessionId of sessionIds) {
      rejected += this.rejectPendingRequestsForSession(sessionId, errorMessage);
    }
    return rejected;
  }

  private logPendingObserveRejected(state: ObserveDebugState, errorMessage: string): void {
    const rejectedAt = Date.now();
    state.latestOffset = this.deps.getLastOffset(state.sessionId);
    this.deps.logger.warn(
      {
        sessionId: state.sessionId,
        requestId: state.requestId,
        view: state.view,
        errorMessage,
        timeoutMs: state.timeoutMs,
        elapsedMs: rejectedAt - state.startedAt,
        startOffset: state.startOffset,
        latestOffset: state.latestOffset,
        outputSeen: state.outputSeen,
        outputEventCount: state.outputEventCount,
        offsetDelta: Math.max(state.latestOffset - state.startOffset, 0),
        component: "terminal_request_dispatcher"
      },
      "Rejected pending terminal observe request"
    );
  }

  private logPendingSendRejected(state: SendDebugState, errorMessage: string): void {
    const rejectedAt = Date.now();
    state.latestOffset = this.deps.getLastOffset(state.sessionId);
    this.deps.logger.warn(
      {
        sessionId: state.sessionId,
        requestId: state.requestId,
        await: state.await,
        errorMessage,
        timeoutMs: state.timeoutMs,
        elapsedMs: rejectedAt - state.startedAt,
        startOffset: state.startOffset,
        latestOffset: state.latestOffset,
        outputSeen: state.outputSeen,
        outputEventCount: state.outputEventCount,
        offsetDelta: Math.max(state.latestOffset - state.startOffset, 0),
        component: "terminal_request_dispatcher"
      },
      "Rejected pending terminal send request"
    );
  }

  private debug(message: string, meta?: Record<string, unknown>) {
    this.deps.logger.info({ ...meta, component: "terminal_request_dispatcher" }, message);
  }

  private pruneRecentObserveStates(now = Date.now()): void {
    const retentionMs = 5 * 60 * 1000;
    for (const [requestId, state] of this.recentObserveStates.entries()) {
      const referenceTime = state.timedOutAt ?? state.startedAt;
      if (!this.pendingObserves.has(requestId) && now - referenceTime > retentionMs) {
        this.recentObserveStates.delete(requestId);
      }
    }
  }

  private pruneRecentSendStates(now = Date.now()): void {
    const retentionMs = 5 * 60 * 1000;
    for (const [requestId, state] of this.recentSendStates.entries()) {
      const referenceTime = state.timedOutAt ?? state.startedAt;
      if (!this.pendingSends.has(requestId) && now - referenceTime > retentionMs) {
        this.recentSendStates.delete(requestId);
      }
    }
  }
}
