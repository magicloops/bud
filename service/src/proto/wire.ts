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

export function decodeLegacyJsonFrame(bytes: Uint8Array): Record<string, unknown> {
  const envelope = decodeBudEnvelope(bytes);
  const legacyJson = envelope.payload.legacy_json;
  const parsed: unknown = JSON.parse(legacyJson.json);
  if (!isRecord(parsed)) {
    throw new Error("legacy_json payload was not an object");
  }
  return parsed;
}

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
          decoded.payload = {
            legacy_json: decodeTypedJsonPayload(fieldNumber, reader.readBytesForWireType(wireType)),
          };
        } else {
          reader.skip(wireType);
        }
        break;
    }
  }

  if (decoded.envelope_version !== BUD_ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope_version: ${decoded.envelope_version ?? "missing"}`);
  }
  if (!decoded.message_id || !decoded.sent_at || !decoded.traffic_class || !decoded.payload?.legacy_json) {
    throw new Error("protobuf envelope missing required compatibility fields");
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
    payload: { legacy_json: decoded.payload.legacy_json },
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
    reader.skip(wireType);
  }
  throw new Error("protobuf envelope missing payload");
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
): LegacyJsonBudEnvelope["payload"]["legacy_json"] {
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
