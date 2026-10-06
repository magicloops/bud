export const latencyBoundsMs = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000] as const;
export type RouteMetric = { method: string; route: string; status_class: string; count: number;
  sum_ms: number; buckets: number[]; response_bytes: number; measured_bytes_count: number };

/** Fixed-size distributions, separate from sampled/severity-filtered request logs. */
export class RequestMetrics {
  private readonly rows = new Map<string, RouteMetric>();
  private overflow = 0;
  observe(method: string, route: string, status: number, duration: number, bytes?: number) {
    if (!Number.isFinite(duration) || duration < 0) return;
    method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method) ? method : "OTHER";
    const status_class = `${Math.floor(status / 100)}xx`;
    const key = JSON.stringify([method, route, status_class]);
    let row = this.rows.get(key);
    if (!row) {
      if (this.rows.size >= 2048) { this.overflow++; return; }
      row = { method, route, status_class, count: 0, sum_ms: 0,
        buckets: Array(latencyBoundsMs.length + 1).fill(0), response_bytes: 0, measured_bytes_count: 0 };
      this.rows.set(key, row);
    }
    row.count++;
    row.sum_ms += duration;
    const index = latencyBoundsMs.findIndex(bound => duration <= bound);
    row.buckets[index < 0 ? latencyBoundsMs.length : index]++;
    if (bytes !== undefined && Number.isFinite(bytes) && bytes >= 0) { row.response_bytes += bytes; row.measured_bytes_count++; }
  }
  drain() {
    const result = { bounds_ms: [...latencyBoundsMs, null], dropped_observations: this.overflow, routes: [...this.rows.values()] };
    this.rows.clear(); this.overflow = 0;
    return result;
  }
}

/** Return the inclusive bucket upper bound; null denotes >30s, not zero. */
export function percentileUpperBound(buckets: number[], quantile: number): number | null {
  const target = Math.ceil(buckets.reduce((sum, count) => sum + count, 0) * quantile);
  if (!target) return null;
  let total = 0;
  for (let i = 0; i < buckets.length; i++) {
    total += buckets[i];
    if (total >= target) return latencyBoundsMs[i] ?? null;
  }
  return null;
}
