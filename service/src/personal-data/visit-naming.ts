import { AccessLog, GEOAPIFY } from "./access-log.js";
import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { locationVisitNameTable as names } from "../db/schema.js";
import { Geoapify, nearbyRadius } from "./geoapify.js";

/** Only recent visits and fixes are named as they come in; older ones by the backfill. */
export const NAMING_WINDOW_MS = 2 * 86400_000;
/** A lookup that found nothing waits this long before it's tried again. */
const RETRY_MS = 10 * 60_000;

type Candidate = { owner: string; key: string; latitude: number; longitude: number; accuracy: number };

/**
 * Names visits and the fixes taken when Bud opens (Phase 11), on the service instead of the phone:
 * a visit when it's first reported and again after a later report (its completion moves the
 * coordinate), and a foreground fix once. The lookups run outside any transaction; the name is
 * then saved by itself. Names the phone sent from Apple (`source = 'apple'`) are left to the
 * backfill, which needs approval.
 */
export class VisitNaming {
  private readonly retryAt = new Map<string, number>();
  constructor(private readonly database: Database = db, private readonly geoapify = new Geoapify(), private readonly now = () => new Date(),
    private readonly log: Pick<AccessLog, "recordQuietly"> = new AccessLog(database)) {}

  get available() { return this.geoapify.available; }

  /** Names up to `limit` candidates; whether any were found (so a caller can keep going). */
  async nameNext(limit = 5, ownerFilter?: string): Promise<boolean> {
    const due = (await this.candidates(limit * 2, ownerFilter))
      .filter(row => (this.retryAt.get(`${row.owner}:${row.key}`) ?? 0) <= this.now().getTime()).slice(0, limit);
    for (const row of due) {
      const address = await this.geoapify.reverse(row.latitude, row.longitude);
      // Candidates within the visit's accuracy (100–200 m); the nearest is its likely place (Phase 12).
      const nearby = await this.geoapify.nearbyPlaces(row.latitude, row.longitude, nearbyRadius(row.accuracy));
      // Both lookups send the visit's coordinate to Geoapify (access log, plan phase 3).
      for (const operation of ["reverse_geocode", "nearby_search"])
        await this.log.recordQuietly({ owner: row.owner, actor: { kind: "processor", ref: GEOAPIFY }, sources: ["location"], operation, recordCount: 1 });
      const place = nearby === undefined ? undefined : nearby[0] ?? null;
      // Nothing found, or a request failed (`nearby` undefined): try again later rather than keep half a name.
      if ((!address && !place) || nearby === undefined) { this.retryAt.set(`${row.owner}:${row.key}`, this.now().getTime() + RETRY_MS); continue; }
      this.retryAt.delete(`${row.owner}:${row.key}`);
      const at = this.now();
      // `received_at` is the service's clock, like the visit's: a later report (a newer
      // `location_visit.received_at`) makes the name stale.
      const values = { address, place, nearby, namedAt: at, receivedAt: sql`clock_timestamp()`, source: "geoapify", rawEventId: null };
      await this.database.insert(names).values({ id: ulid(), visitKey: row.key, createdByUserId: row.owner, ...values })
        .onConflictDoUpdate({ target: [names.createdByUserId, names.visitKey], set: values, setWhere: sql`${names.source} = 'geoapify'` });
    }
    return due.length > 0;
  }

  /** Visits without a name, or with one older than their latest report; foreground fixes without one. */
  private async candidates(limit: number, ownerFilter?: string): Promise<Candidate[]> {
    const since = new Date(this.now().getTime() - NAMING_WINDOW_MS).toISOString();
    const owner = ownerFilter ? sql`and v.created_by_user_id = ${ownerFilter}` : sql``;
    const fixOwner = ownerFilter ? sql`and o.created_by_user_id = ${ownerFilter}` : sql``;
    const result = await this.database.execute<{ owner: string; key: string; latitude: number; longitude: number; accuracy: number }>(sql`
      (select v.created_by_user_id as owner, v.visit_key as key, v.latitude, v.longitude, v.horizontal_accuracy_m as accuracy,
        v.received_at as at
        from location_visit v left join location_visit_name n on n.created_by_user_id = v.created_by_user_id and n.visit_key = v.visit_key
        where v.started_at > ${since}::timestamptz ${owner}
          and (n.id is null or (n.source = 'geoapify' and n.received_at < v.received_at)))
      union all
      (select o.created_by_user_id, o.visit_key, o.latitude, o.longitude, o.horizontal_accuracy_m, o.received_at
        from location_observation o
        join data_event e on e.id = o.raw_event_id and e.created_by_user_id = o.created_by_user_id
        left join location_visit_name n on n.created_by_user_id = o.created_by_user_id and n.visit_key = o.visit_key
        where o.kind = 'fix' and o.visit_key is not null and o.occurred_at > ${since}::timestamptz ${fixOwner}
          and e.raw_envelope->'payload'->>'reason' = 'foreground' and n.id is null)
      order by at limit ${limit}`);
    return result.rows.map(row => ({ owner: row.owner, key: row.key, latitude: Number(row.latitude), longitude: Number(row.longitude),
      accuracy: Number(row.accuracy) }));
  }
}
