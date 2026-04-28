import { Buffer } from "node:buffer";
import { ulid } from "ulid";
import {
  BUD_ENVELOPE_VERSION,
  TRAFFIC_CLASS_PROTO_VALUES,
  TRANSPORT_KIND_PROTO_VALUES,
  type LegacyJsonPayload,
  type LegacyJsonBudEnvelope,
  type TrafficClass,
  type TransportKind,
  trafficClassFromProto,
  transportKindFromProto,
} from "./envelope.js";

const WIRE_VARINT = 0;
const WIRE_64_BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32_BIT = 5;
const LEGACY_JSON_PAYLOAD_FIELD = 100;
const TYPED_FRAME_JSON_FIELD = 99;
const PAYLOAD_FIELD_MIN = 100;
const PAYLOAD_FIELD_MAX = 199;

const TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE: Record<string, number> = {
  error: 101,
  hello: 102,
  hello_ack: 103,
  hello_challenge: 104,
  hello_proof: 105,
  heartbeat: 106,
  heartbeat_ack: 107,
  terminal_ensure: 120,
  terminal_status: 121,
  terminal_input: 122,
  terminal_resize: 123,
  terminal_close: 124,
  terminal_send: 125,
  terminal_send_result: 126,
  terminal_observe: 127,
  terminal_observe_result: 128,
  terminal_output: 129,
  terminal_ready: 130,
  reconnect_report: 150,
  reconciliation_decision: 151,
  data_attach: 170,
  data_attach_ack: 171,
  stream_data: 172,
  stream_credit: 173,
  stream_reset: 174,
  stream_close: 175,
  proxy_open: 176,
  proxy_open_result: 177,
  file_open: 178,
  file_open_result: 179,
};

const FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD = new Map(
  Object.entries(TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE).map(([frameType, fieldNumber]) => [fieldNumber, frameType]),
);

export class UnsupportedBudEnvelopePayloadError extends Error {
  readonly fieldNumber: number;

  constructor(fieldNumber: number) {
    super(`unsupported BudEnvelope payload field ${fieldNumber}`);
    this.name = "UnsupportedBudEnvelopePayloadError";
    this.fieldNumber = fieldNumber;
  }
}

const FIELD_LEVEL_FRAME_TYPES = new Set([
  "error",
  "hello",
  "hello_ack",
  "hello_challenge",
  "hello_proof",
  "heartbeat",
  "heartbeat_ack",
  "terminal_ensure",
  "terminal_status",
  "terminal_input",
  "terminal_resize",
  "terminal_close",
  "terminal_send",
  "terminal_send_result",
  "terminal_observe",
  "terminal_observe_result",
  "terminal_output",
  "terminal_ready",
  "reconnect_report",
  "reconciliation_decision",
]);

const STREAM_TYPE_PROTO_VALUES: Record<string, number> = {
  terminal_interactive: 1,
  localhost_http_proxy: 2,
  file_read: 3,
};

const STREAM_TYPE_JSON_VALUES: Record<number, string> = {
  1: "terminal_interactive",
  2: "localhost_http_proxy",
  3: "file_read",
};

const OPERATION_STATE_PROTO_VALUES: Record<string, number> = {
  offered: 1,
  accepted: 2,
  rejected: 3,
  running: 4,
  succeeded: 5,
  failed: 6,
  canceled: 7,
  unknown: 8,
  expired: 9,
};

const OPERATION_STATE_JSON_VALUES: Record<number, string> = {
  1: "offered",
  2: "accepted",
  3: "rejected",
  4: "running",
  5: "succeeded",
  6: "failed",
  7: "canceled",
  8: "unknown",
  9: "expired",
};

const STREAM_STATE_PROTO_VALUES: Record<string, number> = {
  opening: 1,
  open: 2,
  half_closed_local: 3,
  half_closed_remote: 4,
  closed: 5,
  reset: 6,
  unknown: 7,
  expired: 8,
};

const STREAM_STATE_JSON_VALUES: Record<number, string> = {
  1: "opening",
  2: "open",
  3: "half_closed_local",
  4: "half_closed_remote",
  5: "closed",
  6: "reset",
  7: "unknown",
  8: "expired",
};

const STREAM_RESET_REASON_PROTO_VALUES: Record<string, number> = {
  canceled: 1,
  policy_denied: 2,
  transport_lost: 3,
  timeout: 4,
  backpressure: 5,
  protocol_error: 6,
  local_error: 7,
  remote_error: 8,
};

const STREAM_RESET_REASON_JSON_VALUES: Record<number, string> = {
  1: "canceled",
  2: "policy_denied",
  3: "transport_lost",
  4: "timeout",
  5: "backpressure",
  6: "protocol_error",
  7: "local_error",
  8: "remote_error",
};

export type LegacyJsonEnvelopeOptions = {
  messageId?: string;
  sentAt?: string;
  trafficClass?: TrafficClass;
  transportKind?: TransportKind;
};

export type EncodeBudEnvelopeOptions = {
  forceLegacyJsonPayload?: boolean;
};

export function makeLegacyJsonEnvelope(
  frame: Record<string, unknown>,
  options: LegacyJsonEnvelopeOptions = {},
): LegacyJsonBudEnvelope {
  return {
    envelope_version: BUD_ENVELOPE_VERSION,
    message_id: options.messageId ?? frameMessageId(frame),
    sent_at: options.sentAt ?? frameSentAt(frame),
    traffic_class: options.trafficClass ?? trafficClassForLegacyFrame(frame),
    transport_kind: options.transportKind ?? "websocket",
    payload: {
      legacy_json: {
        json: JSON.stringify(frame),
        ...(typeof frame.type === "string" ? { frame_type: frame.type } : {}),
        ...(typeof frame.proto === "string" ? { proto: frame.proto } : {}),
      },
    },
    extensions: {},
  };
}

export function encodeLegacyJsonFrame(
  frame: Record<string, unknown>,
  options: LegacyJsonEnvelopeOptions = {},
): Buffer {
  return Buffer.from(encodeBudEnvelope(makeLegacyJsonEnvelope(frame, options)));
}

export const encodeBudFrame = encodeLegacyJsonFrame;

export function decodeLegacyJsonFrame(bytes: Uint8Array): Record<string, unknown> {
  const envelope = decodeBudEnvelope(bytes);
  const legacyJson = envelope.payload.legacy_json;
  const parsed: unknown = JSON.parse(legacyJson.json);
  if (!isRecord(parsed)) {
    throw new Error("legacy_json payload was not an object");
  }
  return parsed;
}

export const decodeBudFrame = decodeLegacyJsonFrame;

export function encodeBudEnvelope(
  envelope: LegacyJsonBudEnvelope,
  options: EncodeBudEnvelopeOptions = {},
): Uint8Array {
  const chunks: Buffer[] = [];
  writeUint32(chunks, 1, envelope.envelope_version);
  writeString(chunks, 2, envelope.message_id);
  writeOptionalString(chunks, 3, envelope.correlation_id);
  writeOptionalString(chunks, 4, envelope.operation_id);
  writeOptionalString(chunks, 5, envelope.stream_id);
  writeOptionalString(chunks, 6, envelope.trace_id);
  writeOptionalString(chunks, 7, envelope.bud_id);
  writeOptionalString(chunks, 8, envelope.device_session_id);
  writeOptionalString(chunks, 9, envelope.transport_session_id);
  writeString(chunks, 10, envelope.sent_at);
  writeEnum(chunks, 11, TRAFFIC_CLASS_PROTO_VALUES[envelope.traffic_class]);
  if (envelope.transport_kind) {
    writeEnum(chunks, 12, TRANSPORT_KIND_PROTO_VALUES[envelope.transport_kind]);
  }
  const typedPayload = options.forceLegacyJsonPayload ? null : encodeTypedJsonPayload(envelope);
  if (typedPayload) {
    writeMessage(chunks, typedPayload.fieldNumber, typedPayload.bytes);
  } else {
    writeMessage(chunks, LEGACY_JSON_PAYLOAD_FIELD, encodeLegacyJsonPayload(envelope));
  }
  return Buffer.concat(chunks);
}

export function decodeBudEnvelope(bytes: Uint8Array): LegacyJsonBudEnvelope {
  const reader = new ProtoReader(bytes);
  const decoded: {
    envelope_version?: number;
    message_id?: string;
    correlation_id?: string;
    operation_id?: string;
    stream_id?: string;
    trace_id?: string;
    bud_id?: string;
    device_session_id?: string;
    transport_session_id?: string;
    sent_at?: string;
    traffic_class?: TrafficClass;
    transport_kind?: TransportKind;
    payload?: { legacy_json?: LegacyJsonPayload };
    typedPayload?: { fieldNumber: number; bytes: Uint8Array };
    extensions: Record<string, unknown>;
  } = {
    extensions: {},
  };

  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        decoded.envelope_version = Number(reader.readVarintForWireType(wireType));
        break;
      case 2:
        decoded.message_id = reader.readStringForWireType(wireType);
        break;
      case 3:
        decoded.correlation_id = reader.readStringForWireType(wireType);
        break;
      case 4:
        decoded.operation_id = reader.readStringForWireType(wireType);
        break;
      case 5:
        decoded.stream_id = reader.readStringForWireType(wireType);
        break;
      case 6:
        decoded.trace_id = reader.readStringForWireType(wireType);
        break;
      case 7:
        decoded.bud_id = reader.readStringForWireType(wireType);
        break;
      case 8:
        decoded.device_session_id = reader.readStringForWireType(wireType);
        break;
      case 9:
        decoded.transport_session_id = reader.readStringForWireType(wireType);
        break;
      case 10:
        decoded.sent_at = reader.readStringForWireType(wireType);
        break;
      case 11: {
        const trafficClass = trafficClassFromProto(Number(reader.readVarintForWireType(wireType)));
        if (trafficClass) {
          decoded.traffic_class = trafficClass;
        }
        break;
      }
      case 12: {
        const transportKind = transportKindFromProto(Number(reader.readVarintForWireType(wireType)));
        if (transportKind) {
          decoded.transport_kind = transportKind;
        }
        break;
      }
      case LEGACY_JSON_PAYLOAD_FIELD:
        decoded.payload = {
          legacy_json: decodeLegacyJsonPayload(reader.readBytesForWireType(wireType)),
        };
        break;
      default:
        if (FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD.has(fieldNumber)) {
          decoded.typedPayload = {
            fieldNumber,
            bytes: reader.readBytesForWireType(wireType),
          };
        } else if (isPayloadFieldNumber(fieldNumber)) {
          throw new UnsupportedBudEnvelopePayloadError(fieldNumber);
        } else {
          reader.skip(wireType);
        }
        break;
    }
  }

  if (decoded.envelope_version !== BUD_ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope_version: ${decoded.envelope_version ?? "missing"}`);
  }
  if (!decoded.message_id || !decoded.sent_at || !decoded.traffic_class) {
    throw new Error("protobuf envelope missing required compatibility fields");
  }

  const legacyJson =
    decoded.payload?.legacy_json ??
    (decoded.typedPayload
      ? decodeTypedJsonPayload(decoded.typedPayload.fieldNumber, decoded.typedPayload.bytes, {
          messageId: decoded.message_id,
          sentAt: decoded.sent_at,
        })
      : null);

  if (!legacyJson) {
    throw new Error("protobuf envelope missing payload");
  }

  return {
    envelope_version: BUD_ENVELOPE_VERSION,
    message_id: decoded.message_id,
    correlation_id: decoded.correlation_id,
    operation_id: decoded.operation_id,
    stream_id: decoded.stream_id,
    trace_id: decoded.trace_id,
    bud_id: decoded.bud_id,
    device_session_id: decoded.device_session_id,
    transport_session_id: decoded.transport_session_id,
    sent_at: decoded.sent_at,
    traffic_class: decoded.traffic_class,
    transport_kind: decoded.transport_kind,
    payload: { legacy_json: legacyJson },
    extensions: decoded.extensions ?? {},
  };
}

export function decodeBudEnvelopePayloadCase(bytes: Uint8Array): string {
  const reader = new ProtoReader(bytes);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === LEGACY_JSON_PAYLOAD_FIELD) {
      return "legacy_json";
    }
    const typedFrame = FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD.get(fieldNumber);
    if (typedFrame) {
      return typedFrame;
    }
    if (isPayloadFieldNumber(fieldNumber)) {
      throw new UnsupportedBudEnvelopePayloadError(fieldNumber);
    }
    reader.skip(wireType);
  }
  throw new Error("protobuf envelope missing payload");
}

export function decodeBudEnvelopePayloadEncoding(bytes: Uint8Array): "legacy_json" | "typed_fields" | "typed_frame_json" {
  const reader = new ProtoReader(bytes);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === LEGACY_JSON_PAYLOAD_FIELD) {
      reader.skip(wireType);
      return "legacy_json";
    }
    if (FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD.has(fieldNumber)) {
      const payloadBytes = reader.readBytesForWireType(wireType);
      return payloadContainsFrameJson(payloadBytes) ? "typed_frame_json" : "typed_fields";
    }
    if (isPayloadFieldNumber(fieldNumber)) {
      throw new UnsupportedBudEnvelopePayloadError(fieldNumber);
    }
    reader.skip(wireType);
  }
  throw new Error("protobuf envelope missing payload");
}

function isPayloadFieldNumber(fieldNumber: number): boolean {
  return fieldNumber >= PAYLOAD_FIELD_MIN && fieldNumber <= PAYLOAD_FIELD_MAX;
}

export function trafficClassForLegacyFrame(frame: Record<string, unknown>): TrafficClass {
  const frameType = typeof frame.type === "string" ? frame.type : "";
  if (frameType === "stream_data") {
    const streamType = typeof frame.stream_type === "string" ? frame.stream_type : "";
    return streamType === "file_read" ? "bulk" : "proxy_active";
  }
  if (frameType === "stream_credit" || frameType === "stream_reset" || frameType === "stream_close") {
    return "control";
  }
  if (frameType === "terminal_output" || frameType === "terminal_send" || frameType === "terminal_input") {
    return "interactive";
  }
  if (frameType.startsWith("terminal_")) {
    return "interactive";
  }
  if (frameType === "heartbeat" || frameType === "hello" || frameType.startsWith("hello_")) {
    return "control";
  }
  return "control";
}

function encodeLegacyJsonPayload(envelope: LegacyJsonBudEnvelope): Uint8Array {
  const chunks: Buffer[] = [];
  const legacyJson = envelope.payload.legacy_json;
  writeBytes(chunks, 1, Buffer.from(legacyJson.json, "utf-8"));
  writeOptionalString(chunks, 2, legacyJson.frame_type);
  writeOptionalString(chunks, 3, legacyJson.proto);
  return Buffer.concat(chunks);
}

function encodeTypedJsonPayload(envelope: LegacyJsonBudEnvelope): { fieldNumber: number; bytes: Uint8Array } | null {
  const legacyJson = envelope.payload.legacy_json;
  const frameType = legacyJson.frame_type;
  if (!frameType) {
    return null;
  }
  const fieldNumber = TYPED_PAYLOAD_FIELD_BY_FRAME_TYPE[frameType];
  if (!fieldNumber) {
    return null;
  }

  const parsed = parseFrameJson(legacyJson.json);
  const fieldLevelPayload = encodeFieldLevelPayload(frameType, parsed);
  if (fieldLevelPayload) {
    return { fieldNumber, bytes: fieldLevelPayload };
  }

  const chunks: Buffer[] = [];
  writeBytes(chunks, TYPED_FRAME_JSON_FIELD, Buffer.from(legacyJson.json, "utf-8"));
  return { fieldNumber, bytes: Buffer.concat(chunks) };
}

function decodeLegacyJsonPayload(bytes: Uint8Array): LegacyJsonBudEnvelope["payload"]["legacy_json"] {
  const reader = new ProtoReader(bytes);
  let json: string | null = null;
  let frameType: string | undefined;
  let proto: string | undefined;

  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        json = Buffer.from(reader.readBytesForWireType(wireType)).toString("utf-8");
        break;
      case 2:
        frameType = reader.readStringForWireType(wireType);
        break;
      case 3:
        proto = reader.readStringForWireType(wireType);
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }

  if (!json) {
    throw new Error("legacy_json payload missing json bytes");
  }

  return {
    json,
    ...(frameType ? { frame_type: frameType } : {}),
    ...(proto ? { proto } : {}),
  };
}

function decodeTypedJsonPayload(
  payloadFieldNumber: number,
  bytes: Uint8Array,
  context: { messageId: string; sentAt: string },
): LegacyJsonBudEnvelope["payload"]["legacy_json"] {
  const fieldLevelFrame = decodeFieldLevelPayload(payloadFieldNumber, bytes, context);
  if (fieldLevelFrame) {
    return {
      json: JSON.stringify(fieldLevelFrame),
      frame_type: fieldLevelFrame.type as string,
      proto: fieldLevelFrame.proto as string,
    };
  }

  const reader = new ProtoReader(bytes);
  let json: string | null = null;

  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case TYPED_FRAME_JSON_FIELD:
        json = Buffer.from(reader.readBytesForWireType(wireType)).toString("utf-8");
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }

  if (!json) {
    throw new Error("typed protobuf payload missing frame_json bytes");
  }

  const frameType = FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD.get(payloadFieldNumber);
  return {
    json,
    ...(frameType ? { frame_type: frameType, proto: protoForFrameType(frameType) } : {}),
  };
}

function encodeFieldLevelPayload(frameType: string, frame: Record<string, unknown>): Uint8Array | null {
  if (!FIELD_LEVEL_FRAME_TYPES.has(frameType)) {
    return null;
  }
  const chunks: Buffer[] = [];
  switch (frameType) {
    case "error":
      writeOptionalString(chunks, 1, stringField(frame, "code"));
      writeOptionalString(chunks, 2, stringField(frame, "message"));
      writeOptionalBool(chunks, 3, booleanField(frame, "retryable"));
      writeStringMap(chunks, 4, stringMapField(frame, "details"));
      break;
    case "hello":
      writeOptionalString(chunks, 1, stringField(frame, "name"));
      writeOptionalString(chunks, 2, stringField(frame, "os"));
      writeOptionalString(chunks, 3, stringField(frame, "arch"));
      writeOptionalString(chunks, 4, stringField(frame, "version"));
      writeOptionalString(chunks, 5, stringField(frame, "installation_id"));
      writeOptionalString(chunks, 6, stringField(frame, "token"));
      writeOptionalString(chunks, 7, stringField(frame, "bud_id"));
      writeOptionalJsonBytes(chunks, 8, frame.capabilities);
      break;
    case "hello_ack":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "bud_id"));
      writeOptionalUint32(chunks, 3, numberField(frame, "heartbeat_sec"));
      writeOptionalString(chunks, 4, stringField(frame, "device_secret"));
      break;
    case "hello_challenge":
      writeOptionalString(chunks, 1, stringField(frame, "nonce"));
      break;
    case "hello_proof":
      writeOptionalString(chunks, 1, stringField(frame, "bud_id"));
      writeOptionalString(chunks, 2, stringField(frame, "hmac"));
      break;
    case "heartbeat":
    case "heartbeat_ack":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      break;
    case "terminal_ensure":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalMessage(chunks, 2, encodeTerminalEnsureConfig(recordField(frame, "config")));
      break;
    case "terminal_status":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "state"));
      writeOptionalJsonBytes(chunks, 3, frame.info);
      break;
    case "terminal_input":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalBase64Bytes(chunks, 2, stringField(frame, "data"));
      writeOptionalMessage(chunks, 3, encodeAwaitReady(recordField(frame, "await_ready")));
      break;
    case "terminal_resize":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalUint32(chunks, 2, numberField(frame, "cols"));
      writeOptionalUint32(chunks, 3, numberField(frame, "rows"));
      break;
    case "terminal_close":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "reason"));
      break;
    case "terminal_send":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "request_id"));
      writeOptionalString(chunks, 3, stringField(frame, "text"));
      writeOptionalBool(chunks, 4, booleanField(frame, "submit"));
      writeOptionalString(chunks, 5, stringField(frame, "key"));
      writeOptionalUint64(chunks, 6, numberField(frame, "observe_after_ms"));
      writeOptionalString(chunks, 7, stringField(frame, "wait_for"));
      writeOptionalUint64(chunks, 8, numberField(frame, "timeout_ms"));
      break;
    case "terminal_send_result":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "request_id"));
      writeOptionalBool(chunks, 3, booleanField(frame, "submitted"));
      writeOptionalJsonBytes(chunks, 4, frame.delta);
      writeOptionalJsonBytes(chunks, 5, frame.readiness);
      writeOptionalNullableString(chunks, 6, frame.error);
      break;
    case "terminal_observe":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "request_id"));
      writeOptionalString(chunks, 3, stringField(frame, "view"));
      writeOptionalInt32(chunks, 4, numberField(frame, "lines"));
      writeOptionalString(chunks, 5, stringField(frame, "wait_for"));
      writeOptionalUint64(chunks, 6, numberField(frame, "timeout_ms"));
      break;
    case "terminal_observe_result":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalString(chunks, 2, stringField(frame, "request_id"));
      writeOptionalString(chunks, 3, stringField(frame, "view"));
      writeOptionalBase64Bytes(chunks, 4, stringField(frame, "output"));
      writeOptionalUint64(chunks, 5, numberField(frame, "output_bytes"));
      writeOptionalUint64(chunks, 6, numberField(frame, "lines_captured"));
      writeOptionalBool(chunks, 7, booleanField(frame, "changed"));
      writeOptionalBool(chunks, 8, booleanField(frame, "truncated"));
      writeOptionalJsonBytes(chunks, 9, frame.readiness);
      writeOptionalNullableString(chunks, 10, frame.error);
      break;
    case "terminal_output":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalUint64(chunks, 2, numberField(frame, "seq"));
      writeOptionalBase64Bytes(chunks, 3, stringField(frame, "data"));
      writeOptionalUint64(chunks, 4, numberField(frame, "byte_offset"));
      break;
    case "terminal_ready":
      writeOptionalString(chunks, 1, stringField(frame, "session_id"));
      writeOptionalJsonBytes(chunks, 2, frame.assessment);
      break;
    case "reconnect_report":
      writeOptionalString(chunks, 1, stringField(frame, "bud_id"));
      writeOptionalString(chunks, 2, stringField(frame, "device_session_id"));
      writeRepeatedMessages(chunks, 3, arrayField(frame, "operations").map(encodeOperationStatus));
      writeRepeatedMessages(chunks, 4, arrayField(frame, "streams").map(encodeStreamStatus));
      writeOptionalString(chunks, 5, stringField(frame, "local_policy_version"));
      writeRepeatedStrings(chunks, 6, stringArrayField(frame, "terminal_sessions"));
      break;
    case "reconciliation_decision":
      writeRepeatedMessages(chunks, 1, arrayField(frame, "operations").map(encodeOperationStatus));
      writeRepeatedMessages(chunks, 2, arrayField(frame, "streams").map(encodeStreamStatus));
      break;
    default:
      return null;
  }
  return Buffer.concat(chunks);
}

function decodeFieldLevelPayload(
  payloadFieldNumber: number,
  bytes: Uint8Array,
  context: { messageId: string; sentAt: string },
): Record<string, unknown> | null {
  const frameType = FRAME_TYPE_BY_TYPED_PAYLOAD_FIELD.get(payloadFieldNumber);
  if (!frameType || !FIELD_LEVEL_FRAME_TYPES.has(frameType)) {
    return null;
  }
  if (payloadContainsFrameJson(bytes)) {
    return null;
  }
  const frame: Record<string, unknown> = baseFrame(frameType, context);
  const reader = new ProtoReader(bytes);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (frameType) {
      case "error":
        readBudErrorField(frame, reader, fieldNumber, wireType);
        break;
      case "hello":
        readHelloField(frame, reader, fieldNumber, wireType);
        break;
      case "hello_ack":
        readHelloAckField(frame, reader, fieldNumber, wireType);
        break;
      case "hello_challenge":
        if (fieldNumber === 1) frame.nonce = reader.readStringForWireType(wireType);
        else reader.skip(wireType);
        break;
      case "hello_proof":
        if (fieldNumber === 1) frame.bud_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.hmac = reader.readStringForWireType(wireType);
        else reader.skip(wireType);
        break;
      case "heartbeat":
      case "heartbeat_ack":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else reader.skip(wireType);
        break;
      case "terminal_ensure":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.config = decodeTerminalEnsureConfig(reader.readBytesForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "terminal_status":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.state = reader.readStringForWireType(wireType);
        else if (fieldNumber === 3) frame.info = parseJsonBytes(reader.readBytesForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "terminal_input":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.data = Buffer.from(reader.readBytesForWireType(wireType)).toString("base64");
        else if (fieldNumber === 3) frame.await_ready = decodeAwaitReady(reader.readBytesForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "terminal_resize":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.cols = Number(reader.readVarintForWireType(wireType));
        else if (fieldNumber === 3) frame.rows = Number(reader.readVarintForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "terminal_close":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.reason = reader.readStringForWireType(wireType);
        else reader.skip(wireType);
        break;
      case "terminal_send":
        readTerminalSendField(frame, reader, fieldNumber, wireType);
        break;
      case "terminal_send_result":
        readTerminalSendResultField(frame, reader, fieldNumber, wireType);
        break;
      case "terminal_observe":
        readTerminalObserveField(frame, reader, fieldNumber, wireType);
        break;
      case "terminal_observe_result":
        readTerminalObserveResultField(frame, reader, fieldNumber, wireType);
        break;
      case "terminal_output":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.seq = Number(reader.readVarintForWireType(wireType));
        else if (fieldNumber === 3) frame.data = Buffer.from(reader.readBytesForWireType(wireType)).toString("base64");
        else if (fieldNumber === 4) frame.byte_offset = Number(reader.readVarintForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "terminal_ready":
        if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
        else if (fieldNumber === 2) frame.assessment = parseJsonBytes(reader.readBytesForWireType(wireType));
        else reader.skip(wireType);
        break;
      case "reconnect_report":
        readReconnectReportField(frame, reader, fieldNumber, wireType);
        break;
      case "reconciliation_decision":
        if (fieldNumber === 1) pushArrayValue(frame, "operations", decodeOperationStatus(reader.readBytesForWireType(wireType)));
        else if (fieldNumber === 2) pushArrayValue(frame, "streams", decodeStreamStatus(reader.readBytesForWireType(wireType)));
        else reader.skip(wireType);
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  if ((frameType === "terminal_send_result" || frameType === "terminal_observe_result") && !("error" in frame)) {
    frame.error = null;
  }
  return frame;
}

function encodeTerminalEnsureConfig(value: Record<string, unknown> | null): Uint8Array | null {
  if (!value) {
    return null;
  }
  const chunks: Buffer[] = [];
  writeOptionalString(chunks, 1, stringField(value, "shell"));
  writeOptionalString(chunks, 2, stringField(value, "cwd"));
  writeStringMap(chunks, 3, stringMapField(value, "env"));
  writeOptionalUint32(chunks, 4, numberField(value, "cols"));
  writeOptionalUint32(chunks, 5, numberField(value, "rows"));
  return Buffer.concat(chunks);
}

function decodeTerminalEnsureConfig(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const config: Record<string, unknown> = {};
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        config.shell = reader.readStringForWireType(wireType);
        break;
      case 2:
        config.cwd = reader.readStringForWireType(wireType);
        break;
      case 3:
        config.env = {
          ...(isRecord(config.env) ? config.env : {}),
          ...decodeStringMapEntry(reader.readBytesForWireType(wireType)),
        };
        break;
      case 4:
        config.cols = Number(reader.readVarintForWireType(wireType));
        break;
      case 5:
        config.rows = Number(reader.readVarintForWireType(wireType));
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return config;
}

function encodeAwaitReady(value: Record<string, unknown> | null): Uint8Array | null {
  if (!value) {
    return null;
  }
  const chunks: Buffer[] = [];
  writeOptionalBool(chunks, 1, booleanField(value, "enabled"));
  writeOptionalUint64(chunks, 2, numberField(value, "quiescence_ms"));
  writeOptionalUint64(chunks, 3, numberField(value, "max_wait_ms"));
  writeOptionalBool(chunks, 4, booleanField(value, "activity_based"));
  writeOptionalUint64(chunks, 5, numberField(value, "activity_interval_ms"));
  writeOptionalUint32(chunks, 6, numberField(value, "activity_stable_count"));
  writeOptionalUint64(chunks, 7, numberField(value, "activity_initial_delay_ms"));
  return Buffer.concat(chunks);
}

function decodeAwaitReady(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const awaitReady: Record<string, unknown> = {};
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        awaitReady.enabled = reader.readVarintForWireType(wireType) !== 0n;
        break;
      case 2:
        awaitReady.quiescence_ms = Number(reader.readVarintForWireType(wireType));
        break;
      case 3:
        awaitReady.max_wait_ms = Number(reader.readVarintForWireType(wireType));
        break;
      case 4:
        awaitReady.activity_based = reader.readVarintForWireType(wireType) !== 0n;
        break;
      case 5:
        awaitReady.activity_interval_ms = Number(reader.readVarintForWireType(wireType));
        break;
      case 6:
        awaitReady.activity_stable_count = Number(reader.readVarintForWireType(wireType));
        break;
      case 7:
        awaitReady.activity_initial_delay_ms = Number(reader.readVarintForWireType(wireType));
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return awaitReady;
}

function encodeOperationStatus(value: unknown): Uint8Array {
  const record = isRecord(value) ? value : {};
  const chunks: Buffer[] = [];
  writeOptionalString(chunks, 1, stringField(record, "operation_id"));
  writeOptionalEnum(chunks, 2, OPERATION_STATE_PROTO_VALUES[stringField(record, "state") ?? ""]);
  writeOptionalMessage(chunks, 3, encodeBudError(recordField(record, "error")));
  writeOptionalString(chunks, 4, stringField(record, "operation_type"));
  writeOptionalString(chunks, 5, stringField(record, "updated_at"));
  return Buffer.concat(chunks);
}

function decodeOperationStatus(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const status: Record<string, unknown> = {};
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        status.operation_id = reader.readStringForWireType(wireType);
        break;
      case 2:
        status.state = OPERATION_STATE_JSON_VALUES[Number(reader.readVarintForWireType(wireType))] ?? "unknown";
        break;
      case 3:
        status.error = decodeBudError(reader.readBytesForWireType(wireType));
        break;
      case 4:
        status.operation_type = reader.readStringForWireType(wireType);
        break;
      case 5:
        status.updated_at = reader.readStringForWireType(wireType);
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return status;
}

function encodeStreamStatus(value: unknown): Uint8Array {
  const record = isRecord(value) ? value : {};
  const chunks: Buffer[] = [];
  writeOptionalString(chunks, 1, stringField(record, "stream_id"));
  writeOptionalString(chunks, 2, stringField(record, "operation_id"));
  writeOptionalEnum(chunks, 3, STREAM_TYPE_PROTO_VALUES[stringField(record, "stream_type") ?? ""]);
  writeOptionalEnum(chunks, 4, STREAM_STATE_PROTO_VALUES[stringField(record, "state") ?? ""]);
  writeOptionalUint64(chunks, 5, numberField(record, "send_offset"));
  writeOptionalUint64(chunks, 6, numberField(record, "receive_offset"));
  writeOptionalEnum(chunks, 7, STREAM_RESET_REASON_PROTO_VALUES[stringField(record, "reset_reason") ?? ""]);
  writeOptionalMessage(chunks, 8, encodeBudError(recordField(record, "error")));
  writeOptionalString(chunks, 9, stringField(record, "updated_at"));
  return Buffer.concat(chunks);
}

function decodeStreamStatus(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const status: Record<string, unknown> = {};
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        status.stream_id = reader.readStringForWireType(wireType);
        break;
      case 2:
        status.operation_id = reader.readStringForWireType(wireType);
        break;
      case 3:
        status.stream_type = STREAM_TYPE_JSON_VALUES[Number(reader.readVarintForWireType(wireType))] ?? "terminal_interactive";
        break;
      case 4:
        status.state = STREAM_STATE_JSON_VALUES[Number(reader.readVarintForWireType(wireType))] ?? "unknown";
        break;
      case 5:
        status.send_offset = Number(reader.readVarintForWireType(wireType));
        break;
      case 6:
        status.receive_offset = Number(reader.readVarintForWireType(wireType));
        break;
      case 7:
        status.reset_reason = STREAM_RESET_REASON_JSON_VALUES[Number(reader.readVarintForWireType(wireType))] ?? "protocol_error";
        break;
      case 8:
        status.error = decodeBudError(reader.readBytesForWireType(wireType));
        break;
      case 9:
        status.updated_at = reader.readStringForWireType(wireType);
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return status;
}

function encodeBudError(value: Record<string, unknown> | null): Uint8Array | null {
  if (!value) {
    return null;
  }
  const chunks: Buffer[] = [];
  writeOptionalString(chunks, 1, stringField(value, "code"));
  writeOptionalString(chunks, 2, stringField(value, "message"));
  writeOptionalBool(chunks, 3, booleanField(value, "retryable"));
  writeStringMap(chunks, 4, stringMapField(value, "details"));
  return Buffer.concat(chunks);
}

function decodeBudError(bytes: Uint8Array): Record<string, unknown> {
  const reader = new ProtoReader(bytes);
  const error: Record<string, unknown> = {};
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1:
        error.code = reader.readStringForWireType(wireType);
        break;
      case 2:
        error.message = reader.readStringForWireType(wireType);
        break;
      case 3:
        error.retryable = reader.readVarintForWireType(wireType) !== 0n;
        break;
      case 4:
        error.details = {
          ...(isRecord(error.details) ? error.details : {}),
          ...decodeStringMapEntry(reader.readBytesForWireType(wireType)),
        };
        break;
      default:
        reader.skip(wireType);
        break;
    }
  }
  return error;
}

function readBudErrorField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.code = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.message = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.retryable = reader.readVarintForWireType(wireType) !== 0n;
  else if (fieldNumber === 4) frame.details = { ...(isRecord(frame.details) ? frame.details : {}), ...decodeStringMapEntry(reader.readBytesForWireType(wireType)) };
  else reader.skip(wireType);
}

function readHelloField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.name = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.os = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.arch = reader.readStringForWireType(wireType);
  else if (fieldNumber === 4) frame.version = reader.readStringForWireType(wireType);
  else if (fieldNumber === 5) frame.installation_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 6) frame.token = reader.readStringForWireType(wireType);
  else if (fieldNumber === 7) frame.bud_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 8) frame.capabilities = parseJsonBytes(reader.readBytesForWireType(wireType));
  else reader.skip(wireType);
}

function readHelloAckField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.bud_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.heartbeat_sec = Number(reader.readVarintForWireType(wireType));
  else if (fieldNumber === 4) frame.device_secret = reader.readStringForWireType(wireType);
  else reader.skip(wireType);
}

function readTerminalSendField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.request_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.text = reader.readStringForWireType(wireType);
  else if (fieldNumber === 4) frame.submit = reader.readVarintForWireType(wireType) !== 0n;
  else if (fieldNumber === 5) frame.key = reader.readStringForWireType(wireType);
  else if (fieldNumber === 6) frame.observe_after_ms = Number(reader.readVarintForWireType(wireType));
  else if (fieldNumber === 7) frame.wait_for = reader.readStringForWireType(wireType);
  else if (fieldNumber === 8) frame.timeout_ms = Number(reader.readVarintForWireType(wireType));
  else reader.skip(wireType);
}

function readTerminalSendResultField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.request_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.submitted = reader.readVarintForWireType(wireType) !== 0n;
  else if (fieldNumber === 4) frame.delta = parseJsonBytes(reader.readBytesForWireType(wireType));
  else if (fieldNumber === 5) frame.readiness = parseJsonBytes(reader.readBytesForWireType(wireType));
  else if (fieldNumber === 6) frame.error = reader.readStringForWireType(wireType);
  else reader.skip(wireType);
}

function readTerminalObserveField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.request_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.view = reader.readStringForWireType(wireType);
  else if (fieldNumber === 4) frame.lines = Number(reader.readVarintForWireType(wireType));
  else if (fieldNumber === 5) frame.wait_for = reader.readStringForWireType(wireType);
  else if (fieldNumber === 6) frame.timeout_ms = Number(reader.readVarintForWireType(wireType));
  else reader.skip(wireType);
}

function readTerminalObserveResultField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.request_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) frame.view = reader.readStringForWireType(wireType);
  else if (fieldNumber === 4) frame.output = Buffer.from(reader.readBytesForWireType(wireType)).toString("base64");
  else if (fieldNumber === 5) frame.output_bytes = Number(reader.readVarintForWireType(wireType));
  else if (fieldNumber === 6) frame.lines_captured = Number(reader.readVarintForWireType(wireType));
  else if (fieldNumber === 7) frame.changed = reader.readVarintForWireType(wireType) !== 0n;
  else if (fieldNumber === 8) frame.truncated = reader.readVarintForWireType(wireType) !== 0n;
  else if (fieldNumber === 9) frame.readiness = parseJsonBytes(reader.readBytesForWireType(wireType));
  else if (fieldNumber === 10) frame.error = reader.readStringForWireType(wireType);
  else reader.skip(wireType);
}

function readReconnectReportField(frame: Record<string, unknown>, reader: ProtoReader, fieldNumber: number, wireType: number): void {
  if (fieldNumber === 1) frame.bud_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 2) frame.device_session_id = reader.readStringForWireType(wireType);
  else if (fieldNumber === 3) pushArrayValue(frame, "operations", decodeOperationStatus(reader.readBytesForWireType(wireType)));
  else if (fieldNumber === 4) pushArrayValue(frame, "streams", decodeStreamStatus(reader.readBytesForWireType(wireType)));
  else if (fieldNumber === 5) frame.local_policy_version = reader.readStringForWireType(wireType);
  else if (fieldNumber === 6) pushArrayValue(frame, "terminal_sessions", reader.readStringForWireType(wireType));
  else reader.skip(wireType);
}

function baseFrame(frameType: string, context: { messageId: string; sentAt: string }): Record<string, unknown> {
  return {
    proto: protoForFrameType(frameType),
    type: frameType,
    id: context.messageId,
    ts: sentAtToMillis(context.sentAt),
    ext: {},
  };
}

function payloadContainsFrameJson(bytes: Uint8Array): boolean {
  const reader = new ProtoReader(bytes);
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === TYPED_FRAME_JSON_FIELD) {
      return true;
    }
    reader.skip(wireType);
  }
  return false;
}

function parseFrameJson(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("frame JSON payload was not an object");
  }
  return parsed;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf-8"));
}

function jsonBytes(value: unknown): Buffer | null {
  if (value === undefined || value === null) {
    return null;
  }
  return Buffer.from(JSON.stringify(value), "utf-8");
}

function sentAtToMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : 0;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = record[field];
  return isRecord(value) ? value : null;
}

function arrayField(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

function stringArrayField(record: Record<string, unknown>, field: string): string[] {
  return arrayField(record, field).filter((value): value is string => typeof value === "string");
}

function stringMapField(record: Record<string, unknown>, field: string): Record<string, string> | null {
  const value = record[field];
  if (!isRecord(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") {
      out[key] = nested;
    } else if (nested !== undefined) {
      out[key] = isRecord(nested) || Array.isArray(nested) ? JSON.stringify(nested) : String(nested);
    }
  }
  return out;
}

function pushArrayValue(record: Record<string, unknown>, field: string, value: unknown): void {
  const current = record[field];
  if (Array.isArray(current)) {
    current.push(value);
  } else {
    record[field] = [value];
  }
}

function frameMessageId(frame: Record<string, unknown>): string {
  return typeof frame.id === "string" ? frame.id : `msg_${ulid()}`;
}

function frameSentAt(frame: Record<string, unknown>): string {
  if (typeof frame.ts === "number" && Number.isFinite(frame.ts)) {
    return new Date(frame.ts).toISOString();
  }
  return new Date().toISOString();
}

function protoForFrameType(frameType: string): string {
  return frameType.startsWith("terminal_") ? "0.2" : "0.1";
}

function writeUint32(chunks: Buffer[], fieldNumber: number, value: number): void {
  writeVarintField(chunks, fieldNumber, value);
}

function writeEnum(chunks: Buffer[], fieldNumber: number, value: number): void {
  writeVarintField(chunks, fieldNumber, value);
}

function writeOptionalEnum(chunks: Buffer[], fieldNumber: number, value: number | undefined): void {
  if (value && value > 0) {
    writeEnum(chunks, fieldNumber, value);
  }
}

function writeVarintField(chunks: Buffer[], fieldNumber: number, value: number): void {
  chunks.push(encodeVarint((fieldNumber << 3) | WIRE_VARINT), encodeVarint(value));
}

function writeString(chunks: Buffer[], fieldNumber: number, value: string): void {
  writeBytes(chunks, fieldNumber, Buffer.from(value, "utf-8"));
}

function writeOptionalString(chunks: Buffer[], fieldNumber: number, value: string | undefined): void {
  if (value && value.length > 0) {
    writeString(chunks, fieldNumber, value);
  }
}

function writeOptionalNullableString(chunks: Buffer[], fieldNumber: number, value: unknown): void {
  if (typeof value === "string") {
    writeString(chunks, fieldNumber, value);
  }
}

function writeOptionalBool(chunks: Buffer[], fieldNumber: number, value: boolean | undefined): void {
  if (typeof value === "boolean") {
    writeVarintField(chunks, fieldNumber, value ? 1 : 0);
  }
}

function writeOptionalUint32(chunks: Buffer[], fieldNumber: number, value: number | undefined): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    writeVarintField(chunks, fieldNumber, value);
  }
}

function writeOptionalUint64(chunks: Buffer[], fieldNumber: number, value: number | undefined): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    writeVarintField(chunks, fieldNumber, value);
  }
}

function writeOptionalInt32(chunks: Buffer[], fieldNumber: number, value: number | undefined): void {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    writeVarintField(chunks, fieldNumber, value);
  }
}

function writeOptionalMessage(chunks: Buffer[], fieldNumber: number, value: Uint8Array | null): void {
  if (value) {
    writeMessage(chunks, fieldNumber, value);
  }
}

function writeOptionalJsonBytes(chunks: Buffer[], fieldNumber: number, value: unknown): void {
  const bytes = jsonBytes(value);
  if (bytes) {
    writeBytes(chunks, fieldNumber, bytes);
  }
}

function writeOptionalBase64Bytes(chunks: Buffer[], fieldNumber: number, value: string | undefined): void {
  if (typeof value === "string") {
    writeBytes(chunks, fieldNumber, Buffer.from(value, "base64"));
  }
}

function writeStringMap(chunks: Buffer[], fieldNumber: number, value: Record<string, string> | null): void {
  if (!value) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const entry: Buffer[] = [];
    writeString(entry, 1, key);
    writeString(entry, 2, nested);
    writeMessage(chunks, fieldNumber, Buffer.concat(entry));
  }
}

function writeRepeatedMessages(chunks: Buffer[], fieldNumber: number, values: Uint8Array[]): void {
  for (const value of values) {
    writeMessage(chunks, fieldNumber, value);
  }
}

function writeRepeatedStrings(chunks: Buffer[], fieldNumber: number, values: string[]): void {
  for (const value of values) {
    writeString(chunks, fieldNumber, value);
  }
}

function decodeStringMapEntry(bytes: Uint8Array): Record<string, string> {
  const reader = new ProtoReader(bytes);
  let key: string | null = null;
  let value: string | null = null;
  while (!reader.done()) {
    const { fieldNumber, wireType } = reader.readTag();
    if (fieldNumber === 1) {
      key = reader.readStringForWireType(wireType);
    } else if (fieldNumber === 2) {
      value = reader.readStringForWireType(wireType);
    } else {
      reader.skip(wireType);
    }
  }
  return key ? { [key]: value ?? "" } : {};
}

function writeMessage(chunks: Buffer[], fieldNumber: number, value: Uint8Array): void {
  writeBytes(chunks, fieldNumber, value);
}

function writeBytes(chunks: Buffer[], fieldNumber: number, value: Uint8Array): void {
  chunks.push(
    encodeVarint((fieldNumber << 3) | WIRE_LENGTH_DELIMITED),
    encodeVarint(value.length),
    Buffer.from(value),
  );
}

function encodeVarint(value: number | bigint): Buffer {
  let next = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(next & 0x7fn);
    next >>= 7n;
    if (next !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (next !== 0n);
  return Buffer.from(bytes);
}

class ProtoReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  done(): boolean {
    return this.offset >= this.bytes.length;
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint();
    return {
      fieldNumber: Number(tag >> 3n),
      wireType: Number(tag & 0x07n),
    };
  }

  readVarintForWireType(wireType: number): bigint {
    if (wireType !== WIRE_VARINT) {
      throw new Error(`expected varint wire type, got ${wireType}`);
    }
    return this.readVarint();
  }

  readStringForWireType(wireType: number): string {
    return Buffer.from(this.readBytesForWireType(wireType)).toString("utf-8");
  }

  readBytesForWireType(wireType: number): Uint8Array {
    if (wireType !== WIRE_LENGTH_DELIMITED) {
      throw new Error(`expected length-delimited wire type, got ${wireType}`);
    }
    const length = Number(this.readVarint());
    const start = this.offset;
    const end = start + length;
    if (end > this.bytes.length) {
      throw new Error("protobuf length-delimited field exceeds buffer length");
    }
    this.offset = end;
    return this.bytes.subarray(start, end);
  }

  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_64_BIT:
        this.offset += 8;
        return;
      case WIRE_LENGTH_DELIMITED: {
        const length = Number(this.readVarint());
        this.offset += length;
        if (this.offset > this.bytes.length) {
          throw new Error("protobuf skip exceeded buffer length");
        }
        return;
      }
      case WIRE_32_BIT:
        this.offset += 4;
        return;
      default:
        throw new Error(`unsupported protobuf wire type: ${wireType}`);
    }
  }

  private readVarint(): bigint {
    let shift = 0n;
    let result = 0n;
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result;
      }
      shift += 7n;
      if (shift > 63n) {
        throw new Error("protobuf varint is too large");
      }
    }
    throw new Error("unexpected end of protobuf varint");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
