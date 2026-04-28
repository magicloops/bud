export type CarrierHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface CarrierHealth {
  status: CarrierHealthStatus;
  score: number;
  reason: string | null;
  checkedAt: number | null;
}

export interface CarrierSelectionCandidate {
  transportKind: string;
  role: string | null;
  health: CarrierHealth;
  available: boolean;
  reason: string | null;
}

const DEFAULT_HEALTH: CarrierHealth = {
  status: "healthy",
  score: 100,
  reason: null,
  checkedAt: null,
};

export function healthyCarrierHealth(): CarrierHealth {
  return { ...DEFAULT_HEALTH };
}

export function normalizeCarrierHealth(input: Partial<CarrierHealth> | null | undefined): CarrierHealth {
  if (!input) {
    return healthyCarrierHealth();
  }

  const rawScore = input.score;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.floor(rawScore)))
      : DEFAULT_HEALTH.score;
  const status = input.status ?? statusForScore(score);
  const checkedAt =
    typeof input.checkedAt === "number" && Number.isFinite(input.checkedAt)
      ? input.checkedAt
      : null;
  return {
    status,
    score,
    reason: input.reason ?? null,
    checkedAt,
  };
}

export function carrierHealthAllowsNewWork(health: CarrierHealth): boolean {
  return health.status !== "unhealthy" && health.score >= 50;
}

export function describeCarrierHealth(health: CarrierHealth): string {
  const suffix = health.reason ? `: ${health.reason}` : "";
  return `${health.status}(${health.score})${suffix}`;
}

export function serializeCarrierHealth(health: CarrierHealth | null): Record<string, unknown> | null {
  if (!health) {
    return null;
  }
  return {
    status: health.status,
    score: health.score,
    reason: health.reason,
    checked_at: health.checkedAt,
  };
}

export function serializeCarrierSelectionCandidate(
  candidate: CarrierSelectionCandidate,
): Record<string, unknown> {
  return {
    transport_kind: candidate.transportKind,
    role: candidate.role,
    health: serializeCarrierHealth(candidate.health),
    available: candidate.available,
    reason: candidate.reason,
  };
}

function statusForScore(score: number): CarrierHealthStatus {
  if (score <= 0) {
    return "unhealthy";
  }
  if (score < 50) {
    return "degraded";
  }
  return "healthy";
}
