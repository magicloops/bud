import { config, type DaemonTransportPolicy } from "../config.js";
import type { DataPlaneTransportKind } from "./data-plane-router.js";

export type ControlTransportKind = "websocket" | "h2_grpc";

const CONTROL_ORDER: Record<DaemonTransportPolicy, readonly ControlTransportKind[]> = {
  websocket_baseline: ["websocket", "h2_grpc"],
  h2_preferred: ["h2_grpc", "websocket"],
  quic_preferred: ["h2_grpc", "websocket"],
};

const DATA_PLANE_ORDER: Record<DaemonTransportPolicy, readonly DataPlaneTransportKind[]> = {
  websocket_baseline: ["websocket", "h2_data", "quic"],
  h2_preferred: ["h2_data", "websocket", "quic"],
  quic_preferred: ["quic", "h2_data", "websocket"],
};

export function activeDaemonTransportPolicy(): DaemonTransportPolicy {
  return config.daemonTransportPolicy;
}

export function orderedControlTransportKinds(
  policy: DaemonTransportPolicy = activeDaemonTransportPolicy(),
): readonly ControlTransportKind[] {
  return CONTROL_ORDER[policy];
}

export function orderedDataPlaneTransportKinds(
  policy: DaemonTransportPolicy = activeDaemonTransportPolicy(),
): readonly DataPlaneTransportKind[] {
  return DATA_PLANE_ORDER[policy];
}

export function rankControlTransport(
  kind: ControlTransportKind,
  policy: DaemonTransportPolicy = activeDaemonTransportPolicy(),
): number {
  const rank = orderedControlTransportKinds(policy).indexOf(kind);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

export function rankDataPlaneTransport(
  kind: DataPlaneTransportKind,
  policy: DaemonTransportPolicy = activeDaemonTransportPolicy(),
): number {
  const rank = orderedDataPlaneTransportKinds(policy).indexOf(kind);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}
