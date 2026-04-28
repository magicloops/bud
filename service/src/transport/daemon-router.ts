import type { BudEnvelope, TransportKind } from "../proto/envelope.js";

export type DaemonTransportPayload = Record<string, unknown> | BudEnvelope;

export type DaemonTransportStatus = {
  online: boolean;
  transport_kind: TransportKind | "none";
};

export interface DaemonTransportRouter {
  getActiveBudIds(): string[];
  isBudOnline(budId: string): boolean;
  sendFrameToBud(budId: string, payload: DaemonTransportPayload): boolean;
  getTransportStatus(budId: string): DaemonTransportStatus;
}
