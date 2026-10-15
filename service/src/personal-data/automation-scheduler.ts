import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { automationTable as rules, automationRevisionTable as revisions, automationDeliveryTable as deliveries,
  dataOwnerStateTable as owners } from "../db/schema.js";
import { automationDefinitionSchema } from "./automation-contracts.js";
import { latestWindowAtOrBefore } from "./automation-schedule.js";

/** Materializes due schedule windows as deliveries; admission handles everything else.
 * Only the latest window is considered, so downtime or a pause never causes a burst. */
export class AutomationScheduler {
  private lastScanAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly database: Database = db, private readonly now: () => Date = () => new Date(),
    private readonly scanIntervalMs = 15_000) {}

  async scheduleDue(): Promise<boolean> {
    const now = this.now();
    if (now.getTime() - this.lastScanAt < this.scanIntervalMs) return false;
    this.lastScanAt = now.getTime();
    const candidates = await this.database.select({ id: rules.id, owner: rules.createdByUserId, revision: revisions.revision,
      definition: revisions.definition, activatedAt: revisions.createdAt }).from(rules)
      .innerJoin(revisions, and(eq(revisions.automationId, rules.id), eq(revisions.revision, rules.activeRevision),
        eq(revisions.createdByUserId, rules.createdByUserId)))
      .where(and(eq(rules.state, "enabled"), sql`${revisions.definition}->>'event_type' = 'schedule'`));
    let progressed = false;
    for (const candidate of candidates) {
      const parsed = automationDefinitionSchema.safeParse(candidate.definition);
      if (!parsed.success || parsed.data.event_type !== "schedule") continue;
      const window = latestWindowAtOrBefore(parsed.data.schedule, now);
      // A window before activation (including re-enable after pause) never runs.
      if (!window || window <= candidate.activatedAt) continue;
      const [existing] = await this.database.select({ id: deliveries.id }).from(deliveries).where(and(
        eq(deliveries.automationId, candidate.id), eq(deliveries.createdByUserId, candidate.owner),
        eq(deliveries.scheduledFor, window))).limit(1);
      if (existing) continue;
      const latestStartAt = new Date(window.getTime() + parsed.data.latest_start_seconds * 1000);
      progressed = await this.database.transaction(async tx => {
        // Same owner lock as pause/delete/activation: recheck state under it.
        const [owner] = await tx.select().from(owners).where(eq(owners.createdByUserId, candidate.owner))
          .for("update", { skipLocked: true });
        if (!owner) return false;
        const [rule] = await tx.select({ state: rules.state, activeRevision: rules.activeRevision }).from(rules)
          .where(and(eq(rules.id, candidate.id), eq(rules.createdByUserId, candidate.owner))).limit(1);
        if (rule?.state !== "enabled" || rule.activeRevision !== candidate.revision) return false;
        const [clock] = await tx.execute<{ expired: boolean }>(sql`select clock_timestamp() >= ${latestStartAt.toISOString()}::timestamptz as expired`)
          .then(result => result.rows);
        const inserted = await tx.insert(deliveries).values({ id: ulid(), automationId: candidate.id, revision: candidate.revision,
          scheduledFor: window, latestStartAt, createdByUserId: candidate.owner,
          status: clock.expired ? "expired" : "pending", outcomeCode: clock.expired ? "latest_start_elapsed" : null,
        }).onConflictDoNothing().returning({ id: deliveries.id });
        return inserted.length > 0;
      }) || progressed;
    }
    return progressed;
  }
}
