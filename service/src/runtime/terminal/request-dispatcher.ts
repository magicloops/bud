import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import { ulid } from "ulid";
import { TERMINAL_PROTO_VERSION } from "../../config.js";
import type {
  ReadinessAssessment,
  TerminalContext,
  TerminalDelta,
  TerminalDeltaMessage,
  TerminalObservationView,
  TerminalWaitFor,
} from "../../terminal/types.js";
import { normalizeTerminalSendKeyName } from "../../terminal/types.js";
import type { TerminalSession } from "./session-types.js";

type ObserveDebugState = {
  sessionId: string;
  requestId: string;
  view: TerminalObservationView;
  waitFor: TerminalWaitFor;
  lines: number;
  timeoutMs: number;
  localTimeoutMs: number;
  startedAt: number;
  deadlineAt: number;
  context: TerminalContext;
  readinessAtDispatch: ReadinessAssessment | null;
  startOffset: number;
  latestOffset: number;
  outputSeen: boolean;
  outputEventCount: number;
  timedOutAt?: number;
};

export type ObserveOptions = {
  lines?: number;
  waitFor?: TerminalWaitFor;
  view?: TerminalObservationView;
};

export type ObserveResult = {
  view: TerminalObservationView;
  output: string;
  outputBytes: number;
  linesCaptured: number;
  changed?: boolean;
  truncated?: boolean;
  readiness: ReadinessAssessment;
  error?: string;
};

export type ObserveResponsePayload = {
  requestId: string;
  view: TerminalObservationView;
  output: string;
  outputBytes: number;
  linesCaptured: number;
  changed?: boolean | null;
  truncated?: boolean | null;
  readiness: ReadinessAssessment;
  error: string | null;
};

export type SendInteraction = {
  text?: string;
  submit?: boolean;
  key?: string;
  keys?: string[];
  observeAfterMs?: number;
  waitFor?: TerminalWaitFor;
};

export type SendResult = {
  submitted: boolean;
  delta?: TerminalDelta | null;
  readiness: ReadinessAssessment;
  error?: string;
};

export type SendResultPayload = {
  requestId: string;
  submitted: boolean;
  delta?: TerminalDeltaMessage | null;
  readiness: ReadinessAssessment;
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
};

type TerminalRequestDispatcherDeps = {
  logger: FastifyBaseLogger;
  getSession: (sessionId: string) => Promise<TerminalSession | null>;
  getSessionContext: (sessionId: string) => TerminalContext;
  getLatestReadiness: (sessionId: string) => ReadinessAssessment | null;
  getLastOffset: (sessionId: string) => number;
  storeReadinessAssessment: (sessionId: string, assessment: ReadinessAssessment) => void;
  emitReadyEvent: (sessionId: string, assessment: ReadinessAssessment) => void;
  sendFrameToBud: (budId: string, payload: Record<string, unknown>) => boolean;
  summarizeContextForLog: (context: TerminalContext) => Record<string, unknown>;
  summarizeObservedOutput: (output: string) => Record<string, unknown>;
};

export class TerminalRequestDispatcher {
  private readonly deps: TerminalRequestDispatcherDeps;
  private readonly pendingObserves = new Map<string, PendingObserve>();
  private readonly pendingSends = new Map<string, PendingSend>();
  private readonly recentObserveStates = new Map<string, ObserveDebugState>();

  constructor(deps: TerminalRequestDispatcherDeps) {
    this.deps = deps;
  }

  async observeTerminal(
    sessionId: string,
    options: ObserveOptions = {},
    timeoutMs = 30000
  ): Promise<ObserveResult> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `obs_${ulid()}`;
    const view = options.view ?? "delta";
    const waitFor = options.waitFor ?? "none";
    const lines = options.lines ?? -50;
    const localGraceMs = 1000;
    const localTimeoutMs = timeoutMs + localGraceMs;
    const startedAt = Date.now();
    const deadlineAt = startedAt + localTimeoutMs;
    const context = this.deps.getSessionContext(sessionId);
    const readinessAtDispatch = this.deps.getLatestReadiness(sessionId);
    const startOffset = this.deps.getLastOffset(sessionId);
    const observeState: ObserveDebugState = {
      sessionId,
      requestId,
      view,
      waitFor,
      lines,
      timeoutMs,
      localTimeoutMs,
      startedAt,
      deadlineAt,
      context,
      readinessAtDispatch,
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
      wait_for: waitFor,
      timeout_ms: timeoutMs,
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
        waitFor,
        lines,
        timeoutMs,
        localTimeoutMs,
        startedAt: new Date(startedAt).toISOString(),
        deadlineAt: new Date(deadlineAt).toISOString(),
        context: this.deps.summarizeContextForLog(context),
        readinessAtDispatch,
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
            waitFor: pending.state.waitFor,
            timeoutMs: pending.state.timeoutMs,
            localTimeoutMs: pending.state.localTimeoutMs,
            ageMs: timedOutAt - pending.state.startedAt,
            deadlineAt: new Date(pending.state.deadlineAt).toISOString(),
            contextAtDispatch: this.deps.summarizeContextForLog(pending.state.context),
            contextNow: this.deps.summarizeContextForLog(this.deps.getSessionContext(sessionId)),
            readinessAtDispatch: pending.state.readinessAtDispatch,
            readinessNow: this.deps.getLatestReadiness(sessionId),
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
      }, localTimeoutMs);

      this.pendingObserves.set(requestId, { resolve, reject, timeout, state: observeState });
    });
  }

  async sendInteraction(
    sessionId: string,
    interaction: SendInteraction,
    options: {
      timeoutMs?: number;
    } = {}
  ): Promise<SendResult> {
    const session = await this.deps.getSession(sessionId);
    if (!session) {
      throw new Error("session_not_found");
    }

    const requestId = `send_${ulid()}`;
    const timeoutMs = options.timeoutMs ?? 30000;
    const waitFor = interaction.waitFor ?? "settled";
    const observeAfterMs =
      waitFor === "none" ? (interaction.observeAfterMs ?? 1000) : interaction.observeAfterMs;
    const legacyKeys = interaction.keys?.filter((value) => value.trim().length > 0) ?? [];
    const key = interaction.key?.trim()
      ? normalizeTerminalSendKeyName(interaction.key)
      : legacyKeys.length === 1
        ? normalizeTerminalSendKeyName(legacyKeys[0])
        : undefined;
    const hasTextField = typeof interaction.text === "string";
    const hasTextPayload = typeof interaction.text === "string" && interaction.text.length > 0;

    if (interaction.key && legacyKeys.length > 0) {
      throw new Error("ambiguous_interaction");
    }
    if (legacyKeys.length > 1) {
      throw new Error("multiple_keys_unsupported");
    }
    if (interaction.submit === true && !hasTextField) {
      throw new Error("submit_requires_text");
    }
    if (key && (hasTextField || interaction.submit === true)) {
      throw new Error("ambiguous_interaction");
    }
    if (!hasTextPayload && interaction.submit !== true && !key) {
      throw new Error("empty_interaction");
    }

    const payload = {
      proto: TERMINAL_PROTO_VERSION,
      type: "terminal_send",
      id: `msg_${ulid()}`,
      ts: Date.now(),
      ext: {},
      session_id: sessionId,
      request_id: requestId,
      text: interaction.text ?? null,
      submit: interaction.submit === true,
      key: key ?? null,
      observe_after_ms: observeAfterMs,
      wait_for: waitFor,
      timeout_ms: timeoutMs,
    };

    const sent = this.deps.sendFrameToBud(session.budId, payload);
    if (!sent) {
      throw new Error("bud_offline");
    }

    this.deps.logger.info(
      {
        sessionId,
        requestId,
        hasText: hasTextField,
        submit: interaction.submit === true,
        hasKey: Boolean(key),
        observeAfterMs,
        waitFor,
        timeoutMs,
        component: "terminal_request_dispatcher"
      },
      "Sending terminal_send request"
    );

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(requestId);
        reject(new Error("send_timeout"));
      }, timeoutMs + 1000);

      this.pendingSends.set(requestId, { sessionId, resolve, reject, timeout });
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

    if (observeRequestsSeeingOutput.length > 0) {
      this.debug("terminal output arrived while observe was pending", {
        sessionId,
        requestIds: observeRequestsSeeingOutput,
        byteOffset: details.requestOffset,
        endOffset: details.endOffset,
        outputBytes: details.outputBytes
      });
    }
  }

  handleObserveResult(sessionId: string, payload: ObserveResponsePayload): void {
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
            waitFor: observeState.waitFor,
            timeoutMs: observeState.timeoutMs,
            localTimeoutMs: observeState.localTimeoutMs,
            latencyMs,
            lateByMs: Date.now() - observeState.timedOutAt,
            outputBytes: payload.outputBytes,
            linesCaptured: payload.linesCaptured,
            readiness: payload.readiness,
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
          outputBytes: payload.outputBytes,
          linesCaptured: payload.linesCaptured,
          readiness: payload.readiness,
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
        waitFor: observeState?.waitFor,
        timeoutMs: observeState?.timeoutMs,
        localTimeoutMs: observeState?.localTimeoutMs,
        latencyMs,
        outputBytes: payload.outputBytes,
        linesCaptured: payload.linesCaptured,
        outputSeenDuringWait: observeState?.outputSeen ?? false,
        outputEventCount: observeState?.outputEventCount ?? 0,
        outputOffsetDelta: observeState
          ? Math.max(observeState.latestOffset - observeState.startOffset, 0)
          : 0,
        readiness: payload.readiness,
        outputSummary,
        component: "terminal_request_dispatcher"
      },
      "Observe result received"
    );

    this.deps.storeReadinessAssessment(sessionId, payload.readiness);
    this.deps.emitReadyEvent(sessionId, payload.readiness);

    pending.resolve({
      view: payload.view,
      output,
      outputBytes: payload.outputBytes,
      linesCaptured: payload.linesCaptured,
      changed: typeof payload.changed === "boolean" ? payload.changed : undefined,
      truncated: typeof payload.truncated === "boolean" ? payload.truncated : undefined,
      readiness: payload.readiness,
    });
  }

  handleSendResult(sessionId: string, payload: SendResultPayload): void {
    const pending = this.pendingSends.get(payload.requestId);
    if (!pending) {
      this.deps.logger.warn(
        { sessionId, requestId: payload.requestId, component: "terminal_request_dispatcher" },
        "Orphaned send result"
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingSends.delete(payload.requestId);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    this.deps.logger.info(
      {
        sessionId,
        requestId: payload.requestId,
        submitted: payload.submitted,
        delta: payload.delta
          ? {
              changed: payload.delta.changed,
              textBytes: Buffer.byteLength(payload.delta.text, "utf-8"),
              truncated: payload.delta.truncated,
              summary: this.deps.summarizeObservedOutput(payload.delta.text),
            }
          : null,
        readiness: payload.readiness,
        component: "terminal_request_dispatcher"
      },
      "Send result received"
    );

    this.deps.storeReadinessAssessment(sessionId, payload.readiness);
    this.deps.emitReadyEvent(sessionId, payload.readiness);

    pending.resolve({
      submitted: payload.submitted,
      delta: payload.delta
        ? {
            changed: payload.delta.changed,
            text: payload.delta.text,
            truncated: payload.delta.truncated,
          }
        : null,
      readiness: payload.readiness
    });
  }

  rejectPendingRequestsForSession(sessionId: string, errorMessage: string): number {
    let rejected = 0;

    for (const [requestId, pending] of this.pendingObserves.entries()) {
      if (pending.state.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingObserves.delete(requestId);
      this.recentObserveStates.delete(requestId);
      pending.reject(new Error(errorMessage));
      rejected += 1;
    }

    for (const [requestId, pending] of this.pendingSends.entries()) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingSends.delete(requestId);
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
}
