export const BUD_ENVELOPE_VERSION = 1 as const;

export const TRAFFIC_CLASSES = [
  "control",
  "interactive",
  "proxy_active",
  "bulk",
  "telemetry",
] as const;

export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

export const TRANSPORT_KINDS = [
  "websocket",
  "h2_grpc",
  "h2_data",
  "quic",
] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export const STREAM_TYPES = [
  "terminal_interactive",
  "localhost_http_proxy",
  "file_read",
] as const;

export type StreamType = (typeof STREAM_TYPES)[number];

export type BudError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type LegacyJsonPayload = {
  json: string;
  frame_type?: string;
  proto?: string;
};

export type BudEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  envelope_version: typeof BUD_ENVELOPE_VERSION;
  message_id: string;
  correlation_id?: string;
  operation_id?: string;
  stream_id?: string;
  trace_id?: string;
  bud_id?: string;
  device_session_id?: string;
  transport_session_id?: string;
  sent_at: string;
  traffic_class: TrafficClass;
  transport_kind?: TransportKind;
  payload: TPayload;
  extensions: Record<string, unknown>;
};

export type LegacyJsonBudEnvelope = BudEnvelope<{ legacy_json: LegacyJsonPayload }>;

export const TRAFFIC_CLASS_PROTO_VALUES = {
  control: 1,
  interactive: 2,
  proxy_active: 3,
  bulk: 4,
  telemetry: 5,
} as const satisfies Record<TrafficClass, number>;

export const TRANSPORT_KIND_PROTO_VALUES = {
  websocket: 1,
  h2_grpc: 2,
  h2_data: 3,
  quic: 4,
} as const satisfies Record<TransportKind, number>;

export function trafficClassFromProto(value: number): TrafficClass | null {
  for (const [trafficClass, protoValue] of Object.entries(TRAFFIC_CLASS_PROTO_VALUES)) {
    if (protoValue === value) {
      return trafficClass as TrafficClass;
    }
  }
  return null;
}

export function transportKindFromProto(value: number): TransportKind | null {
  for (const [transportKind, protoValue] of Object.entries(TRANSPORT_KIND_PROTO_VALUES)) {
    if (protoValue === value) {
      return transportKind as TransportKind;
    }
  }
  return null;
}

export function isTrafficClass(value: unknown): value is TrafficClass {
  return typeof value === "string" && TRAFFIC_CLASSES.includes(value as TrafficClass);
}

export function isTransportKind(value: unknown): value is TransportKind {
  return typeof value === "string" && TRANSPORT_KINDS.includes(value as TransportKind);
}

export function isBudEnvelope(value: unknown): value is BudEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.envelope_version === BUD_ENVELOPE_VERSION &&
    typeof value.message_id === "string" &&
    typeof value.sent_at === "string" &&
    isTrafficClass(value.traffic_class) &&
    isRecord(value.payload)
  );
}

export function makeBudError(
  code: string,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): BudError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    ...(options.details ? { details: options.details } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
