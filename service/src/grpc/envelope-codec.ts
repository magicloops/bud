import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import type { DaemonTransportPayload } from "../transport/daemon-router.js";
import {
  BUD_ENVELOPE_VERSION,
  isBudEnvelope,
  type TrafficClass,
  type TransportKind,
} from "../proto/envelope.js";
import { trafficClassForLegacyFrame } from "../proto/wire.js";

type GrpcBudEnvelope = Record<string, unknown>;

const TRAFFIC_CLASS_GRPC_VALUES = {
  control: "TRAFFIC_CLASS_CONTROL",
  interactive: "TRAFFIC_CLASS_INTERACTIVE",
  proxy_active: "TRAFFIC_CLASS_PROXY_ACTIVE",
  bulk: "TRAFFIC_CLASS_BULK",
  telemetry: "TRAFFIC_CLASS_TELEMETRY",
} as const satisfies Record<TrafficClass, string>;

const TRANSPORT_KIND_GRPC_VALUES = {
  websocket: "TRANSPORT_KIND_WEBSOCKET",
  h2_grpc: "TRANSPORT_KIND_H2_GRPC",
  h2_data: "TRANSPORT_KIND_H2_DATA",
  quic: "TRANSPORT_KIND_QUIC",
} as const satisfies Record<TransportKind, string>;

const TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE: Record<string, string> = {
  error: "error",
  hello: "hello",
  hello_ack: "helloAck",
  hello_challenge: "helloChallenge",
  hello_proof: "helloProof",
  heartbeat: "heartbeat",
  heartbeat_ack: "heartbeatAck",
  terminal_ensure: "terminalEnsure",
  terminal_status: "terminalStatus",
  terminal_input: "terminalInput",
  terminal_resize: "terminalResize",
  terminal_close: "terminalClose",
  terminal_send: "terminalSend",
  terminal_send_result: "terminalSendResult",
  terminal_observe: "terminalObserve",
  terminal_observe_result: "terminalObserveResult",
  terminal_output: "terminalOutput",
  terminal_ready: "terminalReady",
  reconnect_report: "reconnectReport",
  reconciliation_decision: "reconciliationDecision",
  data_attach: "dataAttach",
  data_attach_ack: "dataAttachAck",
  stream_data: "streamData",
  stream_credit: "streamCredit",
  stream_reset: "streamReset",
  stream_close: "streamClose",
  proxy_open: "proxyOpen",
  proxy_open_result: "proxyOpenResult",
  file_open: "fileOpen",
  file_open_result: "fileOpenResult",
  file_resolve: "fileResolve",
  file_resolve_result: "fileResolveResult",
  proxy_ws_open: "proxyWsOpen",
  proxy_ws_open_result: "proxyWsOpenResult",
  proxy_ws_message: "proxyWsMessage",
  proxy_ws_close: "proxyWsClose",
  proxy_ws_error: "proxyWsError",
};

const FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD = new Map(
  Object.entries(TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE).map(([frameType, fieldName]) => [fieldName, frameType]),
);

export function encodeGrpcLegacyJsonEnvelope(
  payload: DaemonTransportPayload,
  options: { transportKind?: TransportKind } = {},
): GrpcBudEnvelope {
  const frame = frameFromPayload(payload);
  const frameType = typeof frame.type === "string" ? frame.type : undefined;
  const proto = typeof frame.proto === "string" ? frame.proto : undefined;
  const frameJson = Buffer.from(JSON.stringify(frame), "utf-8");
  const envelope: GrpcBudEnvelope = {
    envelopeVersion: BUD_ENVELOPE_VERSION,
    messageId: typeof frame.id === "string" ? frame.id : `msg_${ulid()}`,
    sentAt: typeof frame.ts === "number" && Number.isFinite(frame.ts)
      ? new Date(frame.ts).toISOString()
      : new Date().toISOString(),
    trafficClass: TRAFFIC_CLASS_GRPC_VALUES[trafficClassForLegacyFrame(frame)],
    transportKind: TRANSPORT_KIND_GRPC_VALUES[options.transportKind ?? "h2_grpc"],
    extensions: {},
  };

  const typedPayloadField = frameType ? TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE[frameType] : undefined;
  if (typedPayloadField) {
    envelope[typedPayloadField] = { frameJson };
    return envelope;
  }

  envelope.legacyJson = {
    json: frameJson,
    ...(frameType ? { frameType } : {}),
    ...(proto ? { proto } : {}),
  };
  return envelope;
}

export function decodeGrpcLegacyJsonEnvelope(message: GrpcBudEnvelope): Record<string, unknown> {
  const legacyJson = getRecordField(message, "legacyJson") ?? getRecordField(message, "legacy_json");
  if (legacyJson) {
    const json = bytesToString(legacyJson.json);
    return parseFrameJson(json);
  }

  for (const [fieldName] of FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD) {
    const payload = getRecordField(message, fieldName) ?? getRecordField(message, snakeCase(fieldName));
    if (!payload) {
      continue;
    }
    const frameJson = payload.frameJson ?? payload.frame_json;
    if (frameJson === undefined) {
      continue;
    }
    return parseFrameJson(bytesToString(frameJson));
  }

  throw new Error("BudEnvelope missing legacy_json or typed frame_json payload");
}

function frameFromPayload(payload: DaemonTransportPayload): Record<string, unknown> {
  if (isBudEnvelope(payload)) {
    const legacyJson = payload.payload.legacy_json;
    if (isRecord(legacyJson) && typeof legacyJson.json === "string") {
      return parseFrameJson(legacyJson.json);
    }
  }
  if (!isRecord(payload)) {
    throw new Error("daemon transport payload must be an object");
  }
  return payload;
}

function parseFrameJson(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("BudEnvelope JSON frame payload was not an object");
  }
  return parsed;
}

function bytesToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf-8");
  }
  throw new Error("BudEnvelope JSON payload was not bytes");
}

function getRecordField(value: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const nested = value[field];
  return isRecord(nested) ? nested : null;
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
