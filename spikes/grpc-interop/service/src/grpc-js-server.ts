import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TextEncoder } from "node:util";

type ClientControlEvent = {
  sessionId: string;
  seq: number;
  kind: string;
  payload: Buffer;
  sentAtUnixMs: number;
};

type ServerControlDirective = {
  sessionId: string;
  seq: number;
  kind: string;
  payload: Buffer;
  sentAtUnixMs: number;
};

type DataFrame = {
  streamId: string;
  seq: number;
  kind: string;
  payload: Buffer;
  offset: number;
};

type ControlCall = grpc.ServerDuplexStream<ClientControlEvent, ServerControlDirective>;
type AttachCall = grpc.ServerDuplexStream<DataFrame, DataFrame>;

const encoder = new TextEncoder();
const maxPayloadBytes = envNumber("BUD_INTEROP_MAX_PAYLOAD_BYTES", 4 * 1024 * 1024);
const slowEchoMs = envNumber("BUD_INTEROP_SLOW_ECHO_MS", 0);

function nowMs(): number {
  return Date.now();
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(encoder.encode(JSON.stringify(value)));
}

function directive(
  sessionId: string,
  seq: number,
  kind: string,
  payload: unknown = {},
): ServerControlDirective {
  return {
    sessionId,
    seq,
    kind,
    payload: encodeJson(payload),
    sentAtUnixMs: nowMs(),
  };
}

function dataFrame(
  streamId: string,
  seq: number,
  kind: string,
  payload: Buffer,
  offset: number,
): DataFrame {
  return {
    streamId,
    seq,
    kind,
    payload,
    offset,
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envOptionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function correlationId(metadata: grpc.Metadata): string {
  const values = metadata.get("x-bud-correlation-id");
  const first = values[0];
  return typeof first === "string" ? first : `grpc-js-${Date.now()}`;
}

function sendInitialMetadata(call: { sendMetadata(metadata: grpc.Metadata): void }, value: string): void {
  const metadata = new grpc.Metadata();
  metadata.set("x-bud-correlation-id", value);
  call.sendMetadata(metadata);
}

async function writeControl(call: ControlCall, frame: ServerControlDirective): Promise<void> {
  if (call.destroyed) {
    return;
  }
  if (call.write(frame)) {
    return;
  }
  await once(call, "drain");
}

async function writeData(call: AttachCall, frame: DataFrame): Promise<void> {
  if (call.destroyed) {
    return;
  }
  if (call.write(frame)) {
    return;
  }
  await once(call, "drain");
}

function failCall(
  call: grpc.ServerDuplexStream<unknown, unknown>,
  code: grpc.status,
  message: string,
  metadataValues: Record<string, string> = {},
): void {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(metadataValues)) {
    metadata.set(key, value);
  }

  const error = Object.assign(new Error(message), {
    code,
    details: message,
    metadata,
  });
  call.emit("error", error);
}

function handleConnect(call: ControlCall): void {
  const requestCorrelationId = correlationId(call.metadata);
  sendInitialMetadata(call, requestCorrelationId);

  let responseSeq = 1;
  let sentDirective = false;
  let inboundEnded = false;
  let pending = 0;
  let terminal = false;

  function maybeEnd(): void {
    if (inboundEnded && pending === 0 && !terminal && !call.destroyed) {
      terminal = true;
      call.end();
    }
  }

  function fail(
    code: grpc.status,
    message: string,
    metadataValues: Record<string, string> = {},
  ): void {
    if (terminal || call.destroyed) {
      return;
    }
    terminal = true;
    failCall(call, code, message, metadataValues);
  }

  call.on("data", (request) => {
    if (terminal) {
      return;
    }
    call.pause();
    pending += 1;
    void (async () => {
      try {
        if (request.payload.byteLength > maxPayloadBytes) {
          fail(grpc.status.RESOURCE_EXHAUSTED, "payload exceeds semantic interop limit");
          return;
        }

        switch (request.kind) {
          case "hello":
            await writeControl(
              call,
              directive(request.sessionId, responseSeq++, "hello_ack", {
                runtime: "grpc-js",
                correlation_id: requestCorrelationId,
              }),
            );
            break;

          case "heartbeat":
            if (!sentDirective) {
              sentDirective = true;
              await writeControl(
                call,
                directive(request.sessionId, responseSeq++, "server_directive", {
                  action: "observe",
                  heartbeat_seq: request.seq,
                }),
              );
            }
            break;

          case "cancel_me":
            fail(grpc.status.CANCELLED, "server cancellation requested");
            return;

          case "failed_precondition":
            fail(grpc.status.FAILED_PRECONDITION, "typed status detail probe", {
              "x-bud-error-kind": "interop_precondition",
              "x-bud-error-retryable": "false",
            });
            return;

          case "deadline_probe":
            await delay(2_000);
            await writeControl(call, directive(request.sessionId, responseSeq++, "deadline_probe_result"));
            break;

          case "drain_request":
            await writeControl(
              call,
              directive(request.sessionId, responseSeq++, "drain_notice", {
                reason: "interop requested drain",
              }),
            );
            terminal = true;
            call.end();
            return;

          default:
            await writeControl(
              call,
              directive(request.sessionId, responseSeq++, "ack", {
                request_kind: request.kind,
                request_seq: request.seq,
              }),
            );
            break;
        }
      } catch (error) {
        fail(
          grpc.status.UNKNOWN,
          error instanceof Error ? error.message : "unknown grpc-js handler error",
        );
      } finally {
        pending -= 1;
        if (!terminal && !call.destroyed && !inboundEnded) {
          call.resume();
        }
        maybeEnd();
      }
    })();
  });

  call.on("end", () => {
    inboundEnded = true;
    maybeEnd();
  });

  call.on("cancelled", () => {
    terminal = true;
  });
}

function handleAttach(call: AttachCall): void {
  let responseSeq = 1;
  let inboundEnded = false;
  let pending = 0;
  let terminal = false;

  function maybeEnd(): void {
    if (inboundEnded && pending === 0 && !terminal && !call.destroyed) {
      terminal = true;
      call.end();
    }
  }

  function fail(code: grpc.status, message: string): void {
    if (terminal || call.destroyed) {
      return;
    }
    terminal = true;
    failCall(call, code, message);
  }

  call.on("data", (frame) => {
    if (terminal) {
      return;
    }
    call.pause();
    pending += 1;
    void (async () => {
      try {
        if (frame.payload.byteLength > maxPayloadBytes) {
          fail(grpc.status.RESOURCE_EXHAUSTED, "attach payload exceeds semantic interop limit");
          return;
        }

        if (slowEchoMs > 0) {
          await delay(slowEchoMs);
        }

        await writeData(
          call,
          dataFrame(frame.streamId, responseSeq++, "data_echo", frame.payload, frame.offset),
        );
      } catch (error) {
        fail(
          grpc.status.UNKNOWN,
          error instanceof Error ? error.message : "unknown grpc-js attach error",
        );
      } finally {
        pending -= 1;
        if (!terminal && !call.destroyed && !inboundEnded) {
          call.resume();
        }
        maybeEnd();
      }
    })();
  });

  call.on("end", () => {
    inboundEnded = true;
    maybeEnd();
  });

  call.on("cancelled", () => {
    terminal = true;
  });
}

const protoPath = path.resolve("proto/bud/interop/v1/interop.proto");
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve("proto")],
});

const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
  bud: {
    interop: {
      v1: {
        BudControlInteropService: grpc.ServiceClientConstructor;
        BudAttachInteropService: grpc.ServiceClientConstructor;
      };
    };
  };
};

const services = loaded.bud.interop.v1;
const serverOptions: grpc.ChannelOptions = {
  "grpc.max_receive_message_length": maxPayloadBytes,
  "grpc.max_send_message_length": maxPayloadBytes,
};
const maxConcurrentStreams = envOptionalNumber("GRPC_JS_MAX_CONCURRENT_STREAMS");
const maxSessionMemory = envOptionalNumber("GRPC_JS_MAX_SESSION_MEMORY");
const enableChannelz = envOptionalNumber("GRPC_JS_ENABLE_CHANNELZ");

if (maxConcurrentStreams !== undefined) {
  serverOptions["grpc.max_concurrent_streams"] = maxConcurrentStreams;
}
if (maxSessionMemory !== undefined) {
  serverOptions["grpc-node.max_session_memory"] = maxSessionMemory;
}
if (enableChannelz !== undefined) {
  serverOptions["grpc.enable_channelz"] = enableChannelz;
}

const server = new grpc.Server(serverOptions);

server.addService(services.BudControlInteropService.service, {
  connect: handleConnect,
});
server.addService(services.BudAttachInteropService.service, {
  attach: handleAttach,
});

const port = envNumber("GRPC_JS_INTEROP_PORT", 50052);
server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (error) => {
  if (error) {
    throw error;
  }

  console.log(`grpc-js interop server listening on http://127.0.0.1:${port}`);
  console.log("grpc-js server options", serverOptions);
});

function shutdown(): void {
  server.tryShutdown(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
