import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { create } from "@bufbuild/protobuf";
import http2 from "node:http2";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";
import {
  BudAttachInteropService,
  BudControlInteropService,
  DataFrameSchema,
  ServerControlDirectiveSchema,
  type ClientControlEvent,
  type DataFrame,
  type ServerControlDirective,
} from "./gen/bud/interop/v1/interop_pb.js";
import { AsyncQueue } from "./async-queue.js";

const encoder = new TextEncoder();
const maxPayloadBytes = envNumber("BUD_INTEROP_MAX_PAYLOAD_BYTES", 4 * 1024 * 1024);
const slowEchoMs = envNumber("BUD_INTEROP_SLOW_ECHO_MS", 0);
const deadlineMode = process.env.CONNECT_INTEROP_DEADLINE_MODE ?? "context-reason";

function nowMs(): bigint {
  return BigInt(Date.now());
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function directive(
  sessionId: string,
  seq: bigint,
  kind: string,
  payload: unknown = {},
): ServerControlDirective {
  return create(ServerControlDirectiveSchema, {
    sessionId,
    seq,
    kind,
    payload: encodeJson(payload),
    sentAtUnixMs: nowMs(),
  });
}

function dataFrame(
  streamId: string,
  seq: bigint,
  kind: string,
  payload: Uint8Array,
  offset: bigint,
): DataFrame {
  return create(DataFrameSchema, {
    streamId,
    seq,
    kind,
    payload,
    offset,
  });
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function delayWithContextSignal(ms: number, context: HandlerContext): Promise<void> {
  try {
    await delay(ms, undefined, { signal: context.signal });
  } catch (error) {
    logDeadlineAbort("context-reason", error, context);
    if (context.signal.aborted && context.signal.reason) {
      throw context.signal.reason;
    }
    throw error;
  }
}

async function delayWithExplicitDeadlineStatus(ms: number, context: HandlerContext): Promise<void> {
  try {
    await delay(ms, undefined, { signal: context.signal });
  } catch (error) {
    logDeadlineAbort("catch-explicit-status", error, context);
    if (context.signal.aborted) {
      throw new ConnectError("deadline exceeded from context signal", Code.DeadlineExceeded);
    }
    throw error;
  }
}

async function runDeadlineProbe(context: HandlerContext): Promise<void> {
  switch (deadlineMode) {
    case "explicit-status":
      throw new ConnectError("explicit deadline probe", Code.DeadlineExceeded);
    case "catch-explicit-status":
      await delayWithExplicitDeadlineStatus(2_000, context);
      return;
    case "context-reason":
      await delayWithContextSignal(2_000, context);
      return;
    default:
      throw new ConnectError(
        `unknown CONNECT_INTEROP_DEADLINE_MODE ${deadlineMode}`,
        Code.InvalidArgument,
      );
  }
}

function logDeadlineAbort(mode: string, error: unknown, context: HandlerContext): void {
  console.warn(
    "connect deadline abort",
    JSON.stringify({
      mode,
      signal_aborted: context.signal.aborted,
      signal_reason: describeError(context.signal.reason),
      thrown_error: describeError(error),
    }),
  );
}

function describeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof ConnectError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return {
    value: String(error),
  };
}

async function* connect(
  requests: AsyncIterable<ClientControlEvent>,
  context: HandlerContext,
): AsyncIterable<ServerControlDirective> {
  const correlationId =
    context.requestHeader.get("x-bud-correlation-id") ?? `connect-${Date.now()}`;
  context.responseHeader.set("x-bud-correlation-id", correlationId);

  const queue = new AsyncQueue<ServerControlDirective>();
  let responseSeq = 1n;
  let sentDirective = false;

  const reader = (async () => {
    try {
      for await (const request of requests) {
        if (request.payload.byteLength > maxPayloadBytes) {
          throw new ConnectError("payload exceeds semantic interop limit", Code.ResourceExhausted);
        }

        switch (request.kind) {
          case "hello":
            queue.push(
              directive(request.sessionId, responseSeq++, "hello_ack", {
                runtime: "connect",
                correlation_id: correlationId,
              }),
            );
            break;

          case "heartbeat":
            if (!sentDirective) {
              sentDirective = true;
              queue.push(
                directive(request.sessionId, responseSeq++, "server_directive", {
                  action: "observe",
                  heartbeat_seq: request.seq.toString(),
                }),
              );
            }
            break;

          case "cancel_me":
            throw new ConnectError("server cancellation requested", Code.Canceled);

          case "failed_precondition":
            throw new ConnectError(
              "typed status detail probe",
              Code.FailedPrecondition,
              {
                "x-bud-error-kind": "interop_precondition",
                "x-bud-error-retryable": "false",
              },
            );

          case "deadline_probe":
            await runDeadlineProbe(context);
            queue.push(directive(request.sessionId, responseSeq++, "deadline_probe_result"));
            break;

          case "drain_request":
            queue.push(
              directive(request.sessionId, responseSeq++, "drain_notice", {
                reason: "interop requested drain",
              }),
            );
            return;

          default:
            queue.push(
              directive(request.sessionId, responseSeq++, "ack", {
                request_kind: request.kind,
                request_seq: request.seq.toString(),
              }),
            );
            break;
        }
      }
    } catch (error) {
      queue.fail(error);
      return;
    } finally {
      queue.close();
    }
  })();

  try {
    for await (const item of queue) {
      yield item;
    }
  } finally {
    await reader.catch(() => undefined);
  }
}

async function* attach(frames: AsyncIterable<DataFrame>): AsyncIterable<DataFrame> {
  let responseSeq = 1n;

  for await (const frame of frames) {
    if (frame.payload.byteLength > maxPayloadBytes) {
      throw new ConnectError("attach payload exceeds semantic interop limit", Code.ResourceExhausted);
    }

    if (slowEchoMs > 0) {
      await delay(slowEchoMs);
    }

    yield dataFrame(frame.streamId, responseSeq++, "data_echo", frame.payload, frame.offset);
  }
}

const server = http2.createServer(
  connectNodeAdapter({
    routes(router) {
      router.service(BudControlInteropService, { connect });
      router.service(BudAttachInteropService, { attach });
    },
    connect: false,
    grpc: true,
    grpcWeb: false,
  }),
);

const port = envNumber("CONNECT_INTEROP_PORT", 50051);
server.listen(port, "127.0.0.1", () => {
  console.log(`connect interop server listening on http://127.0.0.1:${port}`);
  console.log(`connect deadline mode ${deadlineMode}`);
});

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
