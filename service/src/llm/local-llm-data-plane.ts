import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import { z } from "zod";
import { PROTO_VERSION, config } from "../config.js";
import { DaemonStateStore } from "../runtime/daemon-state.js";
import {
  checkDataPlaneRuntimeStreamCapacity,
  registerDataPlaneRuntimeStream,
  selectDataPlaneCarrier,
  sendDataPlaneControlFrame,
  sendDataPlaneFrame,
  sendDataPlaneStreamData,
  type DataPlaneSessionTracker,
} from "../transport/data-plane-router.js";
import { EnvelopeSchema } from "../ws/protocol.js";

export const LOCAL_LLM_HTTP_STREAM_TYPE = "local_llm_http";
export const LOCAL_LLM_DS4_SERVER_ID = "ds4";

const LOCAL_LLM_MAX_CONCURRENT_STREAMS_PER_BUD = 1;
const LOCAL_LLM_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const LOCAL_LLM_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const BudErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});

const LocalLlmOpenResultSchema = EnvelopeSchema.extend({
  type: z.literal("local_llm_open_result"),
  operation_id: z.string(),
  stream_id: z.string(),
  accepted: z.boolean(),
  status_code: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
  compatibility: z.string().optional(),
  request_mode: z.string().optional(),
  error: BudErrorSchema.optional(),
});

export type LocalLlmOpenResultFrame = z.infer<typeof LocalLlmOpenResultSchema>;

export class BudLocalLlmUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "BudLocalLlmUnavailableError";
  }
}

type PendingOpenResult = {
  resolve(frame: LocalLlmOpenResultFrame): void;
  reject(error: unknown): void;
  budId: string;
  operationId: string;
  streamId: string;
  ownerUserId?: string | null;
  threadId?: string | null;
  localLlmServerId: typeof LOCAL_LLM_DS4_SERVER_ID;
  provider: "ds4";
  model: string;
  requestMode: "ds4_openai_responses";
};

type OpenBudLocalLlmHttpArgs = {
  budId: string;
  threadId?: string | null;
  ownerUserId?: string | null;
  localLlmServerId: typeof LOCAL_LLM_DS4_SERVER_ID;
  provider: "ds4";
  model: string;
  requestMode: "ds4_openai_responses";
  method: "POST";
  path: "/v1/responses";
  headers: Record<string, string>;
  body: Buffer;
  signal?: AbortSignal;
};

type OpenBudLocalLlmHttpResult = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
  streamId: string;
  operationId: string;
};

const pendingOpenResults = new Map<string, PendingOpenResult>();

export function handleLocalLlmOpenResult(raw: unknown): LocalLlmOpenResultFrame | null {
  const result = LocalLlmOpenResultSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }

  const frame = result.data;
  const pending = pendingOpenResults.get(frame.stream_id);
  if (pending) {
    void recordLocalLlmOpenResult(frame, pending).finally(() => {
      if (frame.accepted) {
        pending.resolve(frame);
      } else {
        pending.reject(
          new BudLocalLlmUnavailableError(
            frame.error?.code ?? "LOCAL_LLM_OPEN_REJECTED",
            frame.error?.message ?? "Bud rejected local LLM stream",
            frame.error?.retryable ?? false,
          ),
        );
      }
    });
  }
  return frame;
}

export async function openBudLocalLlmHttp(
  args: OpenBudLocalLlmHttpArgs,
): Promise<OpenBudLocalLlmHttpResult> {
  if (args.body.byteLength > LOCAL_LLM_MAX_REQUEST_BODY_BYTES) {
    throw new BudLocalLlmUnavailableError(
      "LOCAL_LLM_REQUEST_TOO_LARGE",
      "Bud-local LLM request body exceeds the local stream limit",
      false,
    );
  }

  const capacity = checkDataPlaneRuntimeStreamCapacity({
    budId: args.budId,
    streamType: LOCAL_LLM_HTTP_STREAM_TYPE,
    maxConcurrentStreams: LOCAL_LLM_MAX_CONCURRENT_STREAMS_PER_BUD,
  });
  if (!capacity.ok) {
    throw new BudLocalLlmUnavailableError(capacity.code, capacity.message, true);
  }

  const selection = selectDataPlaneCarrier({
    budId: args.budId,
    streamType: LOCAL_LLM_HTTP_STREAM_TYPE,
    policy: config.daemonTransportPolicy,
  });
  if (!selection.available) {
    throw new BudLocalLlmUnavailableError(selection.code, selection.message, true);
  }

  const tracker = selection.tracker;
  const streamId = `llm_st_${ulid()}`;
  const operationId = `llm_op_${ulid()}`;
  const daemonStateStore = new DaemonStateStore();

  let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let responseBytes = 0;
  let settled = false;
  let opened = false;
  let cleanupAbort: (() => void) | null = null;

  const markServiceReset = (
    reason: string,
    error: { code: string; message: string; retryable: boolean },
  ) => {
    const canceled = reason === "canceled" || error.code === "LOCAL_LLM_ABORTED";
    void daemonStateStore.transitionOperation({
      operationId,
      from: opened ? ["accepted", "running"] : ["offered"],
      to: canceled ? "canceled" : opened ? "failed" : "rejected",
      error,
    });
    void daemonStateStore.transitionStream({
      streamId,
      from: ["opening", "open", "half_closed_local", "half_closed_remote"],
      to: "reset",
      resetReason: reason,
      error,
    });
    void daemonStateStore.appendAuditEvent({
      eventType: "local_llm.stream_reset",
      budId: args.budId,
      userId: args.ownerUserId ?? null,
      operationId,
      streamId,
      createdByUserId: args.ownerUserId ?? null,
      eventData: {
        reason,
        error,
        local_llm_server_id: args.localLlmServerId,
        provider: args.provider,
        model: args.model,
        request_mode: args.requestMode,
      },
    });
  };

  const cleanup = () => {
    pendingOpenResults.delete(streamId);
    cleanupAbort?.();
    tracker.runtimeStreams.delete(streamId);
  };

  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      responseController = controller;
    },
    cancel() {
      const error = {
        code: "LOCAL_LLM_RESPONSE_CANCELED",
        message: "local LLM response stream was canceled",
        retryable: true,
      };
      void resetLocalLlmStream(tracker, streamId, "canceled", error);
      markServiceReset("canceled", error);
      cleanup();
    },
  });

  const openResult = new Promise<LocalLlmOpenResultFrame>((resolve, reject) => {
    pendingOpenResults.set(streamId, {
      resolve,
      reject,
      budId: args.budId,
      operationId,
      streamId,
      ownerUserId: args.ownerUserId ?? null,
      threadId: args.threadId ?? null,
      localLlmServerId: args.localLlmServerId,
      provider: args.provider,
      model: args.model,
      requestMode: args.requestMode,
    });
  });

  registerDataPlaneRuntimeStream(tracker, {
    streamId,
    streamType: LOCAL_LLM_HTTP_STREAM_TYPE,
    initialReceiveCreditBytes: selection.initialCreditBytes,
    initialSendCreditBytes: args.body.byteLength,
    onData(chunk) {
      responseBytes += chunk.byteLength;
      if (responseBytes > LOCAL_LLM_MAX_RESPONSE_BYTES) {
        const error = new BudLocalLlmUnavailableError(
          "LOCAL_LLM_RESPONSE_TOO_LARGE",
          "Bud-local LLM response exceeded the local stream limit",
          false,
        );
        responseController?.error(error);
        void resetLocalLlmStream(tracker, streamId, "local_error", {
          code: error.code,
          message: error.message,
          retryable: false,
        });
        markServiceReset("local_error", {
          code: error.code,
          message: error.message,
          retryable: false,
        });
        cleanup();
        return;
      }
      responseController?.enqueue(new Uint8Array(chunk));
    },
    onReset(frame) {
      const error = new BudLocalLlmUnavailableError(
        frame.error?.code ?? "LOCAL_LLM_STREAM_RESET",
        frame.error?.message ?? `Bud-local LLM stream reset: ${frame.reason}`,
        frame.error?.retryable ?? true,
      );
      if (!opened) {
        pendingOpenResults.get(streamId)?.reject(error);
      }
      responseController?.error(error);
      void daemonStateStore.transitionOperation({
        operationId,
        from: opened ? ["accepted", "running"] : ["offered"],
        to: frame.reason === "canceled" ? "canceled" : opened ? "failed" : "unknown",
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      });
      cleanup();
    },
    onClose() {
      settled = true;
      responseController?.close();
      void daemonStateStore.transitionOperation({
        operationId,
        from: ["accepted", "running"],
        to: "succeeded",
      });
      cleanup();
    },
  });

  await daemonStateStore.createOperation({
    operationId,
    budId: args.budId,
    operationType: LOCAL_LLM_HTTP_STREAM_TYPE,
    trafficClass: "llm",
    state: "offered",
    threadId: args.threadId ?? null,
    deviceSessionId: selection.deviceSessionId,
    transportSessionId: selection.controlTransportSessionId,
    request: {
      local_llm_server_id: args.localLlmServerId,
      provider: args.provider,
      model: args.model,
      request_mode: args.requestMode,
      method: args.method,
      path: args.path,
      request_body_bytes: args.body.byteLength,
      transport_kind: tracker.transportKind,
    },
    createdByUserId: args.ownerUserId ?? null,
  });
  await daemonStateStore.createStream({
    streamId,
    operationId,
    budId: args.budId,
    streamType: LOCAL_LLM_HTTP_STREAM_TYPE,
    trafficClass: "llm",
    state: "opening",
    deviceSessionId: selection.deviceSessionId,
    transportSessionId: selection.dataTransportSessionId,
    createdByUserId: args.ownerUserId ?? null,
  });
  await daemonStateStore
    .appendAuditEvent({
      eventType: "local_llm.stream_open",
      budId: args.budId,
      userId: args.ownerUserId ?? null,
      operationId,
      streamId,
      createdByUserId: args.ownerUserId ?? null,
      eventData: {
        operation_id: operationId,
        local_llm_server_id: args.localLlmServerId,
        provider: args.provider,
        model: args.model,
        request_mode: args.requestMode,
        path: args.path,
        method: args.method,
        request_body_bytes: args.body.byteLength,
        transport_kind: tracker.transportKind,
      },
    })
    .catch(() => null);

  if (args.signal) {
    const abortError = {
      code: "LOCAL_LLM_ABORTED",
      message: "Bud-local LLM request was aborted",
      retryable: true,
    };
    if (args.signal.aborted) {
      markServiceReset("canceled", abortError);
      cleanup();
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const onAbort = () => {
      void resetLocalLlmStream(tracker, streamId, "canceled", abortError);
      pendingOpenResults
        .get(streamId)
        ?.reject(new DOMException("The operation was aborted.", "AbortError"));
      responseController?.error(new DOMException("The operation was aborted.", "AbortError"));
      markServiceReset("canceled", abortError);
      cleanup();
    };
    args.signal.addEventListener("abort", onAbort, { once: true });
    cleanupAbort = () => args.signal?.removeEventListener("abort", onAbort);
  }

  const sentOpen = sendDataPlaneControlFrame(tracker, {
    proto: PROTO_VERSION,
    type: "local_llm_open",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    operation_id: operationId,
    stream_id: streamId,
    stream_type: LOCAL_LLM_HTTP_STREAM_TYPE,
    local_llm_server_id: args.localLlmServerId,
    method: args.method,
    path: args.path,
    headers: args.headers,
    request_body_bytes: args.body.byteLength,
    initial_credit_bytes: selection.initialCreditBytes,
    max_chunk_bytes: selection.maxChunkBytes,
  });

  if (!sentOpen) {
    markServiceReset("local_error", {
      code: "LOCAL_LLM_CONTROL_SEND_FAILED",
      message: "Failed to send local LLM open frame to Bud",
      retryable: true,
    });
    cleanup();
    throw new BudLocalLlmUnavailableError(
      "LOCAL_LLM_CONTROL_SEND_FAILED",
      "Failed to send local LLM open frame to Bud",
      true,
    );
  }

  try {
    await sendRequestBody(tracker, streamId, args.body, selection.maxChunkBytes);
    const frame = await openResult;
    opened = true;
    return {
      status: frame.status_code ?? 502,
      headers: new Headers(frame.headers ?? {}),
      body: responseBody,
      streamId,
      operationId,
    };
  } catch (error) {
    if (!settled && tracker.runtimeStreams.has(streamId)) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const resetError = {
        code: error instanceof BudLocalLlmUnavailableError
          ? error.code
          : aborted
            ? "LOCAL_LLM_ABORTED"
            : "LOCAL_LLM_OPEN_FAILED",
        message: error instanceof Error ? error.message : "local LLM stream failed before open",
        retryable: error instanceof BudLocalLlmUnavailableError ? error.retryable : true,
      };
      await resetLocalLlmStream(tracker, streamId, aborted ? "canceled" : "local_error", {
        code: resetError.code,
        message: resetError.message,
        retryable: resetError.retryable,
      }).catch(() => null);
      markServiceReset(aborted ? "canceled" : "local_error", resetError);
    }
    cleanup();
    throw error;
  }
}

async function recordLocalLlmOpenResult(
  frame: LocalLlmOpenResultFrame,
  pending: PendingOpenResult,
): Promise<void> {
  const daemonStateStore = new DaemonStateStore();
  const error = frame.error
    ? {
        code: frame.error.code,
        message: frame.error.message,
        retryable: frame.error.retryable,
        details: frame.error.details,
      }
    : null;

  if (frame.accepted) {
    await daemonStateStore
      .transitionOperation({
        operationId: pending.operationId,
        from: ["offered"],
        to: "accepted",
        result: {
          status_code: frame.status_code ?? null,
          compatibility: frame.compatibility ?? null,
          request_mode: frame.request_mode ?? null,
        },
      })
      .catch(() => null);
    await daemonStateStore
      .transitionOperation({
        operationId: pending.operationId,
        from: ["accepted"],
        to: "running",
      })
      .catch(() => null);
    await daemonStateStore
      .transitionStream({
        streamId: pending.streamId,
        from: ["opening"],
        to: "open",
      })
      .catch(() => null);
  } else {
    await daemonStateStore
      .transitionOperation({
        operationId: pending.operationId,
        from: ["offered"],
        to: "rejected",
        error,
      })
      .catch(() => null);
    await daemonStateStore
      .transitionStream({
        streamId: pending.streamId,
        from: ["opening", "open", "half_closed_local", "half_closed_remote"],
        to: "reset",
        resetReason: "open_rejected",
        error,
      })
      .catch(() => null);
  }

  await daemonStateStore
    .appendAuditEvent({
      eventType: "local_llm.open_result",
      budId: pending.budId,
      userId: pending.ownerUserId ?? null,
      operationId: pending.operationId,
      streamId: pending.streamId,
      createdByUserId: pending.ownerUserId ?? null,
      eventData: {
        accepted: frame.accepted,
        status_code: frame.status_code ?? null,
        error: error ?? null,
        local_llm_server_id: pending.localLlmServerId,
        provider: pending.provider,
        model: pending.model,
        request_mode: pending.requestMode,
        response_request_mode: frame.request_mode ?? null,
        compatibility: frame.compatibility ?? null,
      },
    })
    .catch(() => null);
}

async function sendRequestBody(
  tracker: DataPlaneSessionTracker,
  streamId: string,
  body: Buffer,
  maxChunkBytes: number,
): Promise<void> {
  if (body.byteLength === 0) {
    await sendDataPlaneStreamData(tracker, {
      streamId,
      data: Buffer.alloc(0),
      endStream: true,
      maxChunkBytes,
    });
    return;
  }

  for (let offset = 0; offset < body.byteLength; offset += maxChunkBytes) {
    const end = Math.min(offset + maxChunkBytes, body.byteLength);
    await sendDataPlaneStreamData(tracker, {
      streamId,
      data: body.subarray(offset, end),
      endStream: end === body.byteLength,
      maxChunkBytes,
    });
  }
}

async function resetLocalLlmStream(
  tracker: DataPlaneSessionTracker,
  streamId: string,
  reason: string,
  error: { code: string; message: string; retryable: boolean },
): Promise<void> {
  await sendDataPlaneFrame(tracker, {
    proto: PROTO_VERSION,
    type: "stream_reset",
    id: `msg_${ulid()}`,
    ts: Date.now(),
    ext: {},
    stream_id: streamId,
    reason,
    error,
  });
}
