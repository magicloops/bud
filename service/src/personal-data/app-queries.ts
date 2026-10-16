import { z } from "zod";
import { AppKeys } from "./app-keys.js";
import { ContactQueries } from "./contact-queries.js";
import { LocationQueries, locationWindow } from "./location.js";
import { HealthQueries, healthWindow } from "./health.js";
import { DataRequestError } from "./contracts.js";

const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(600).optional() };
const contactId = z.string().min(1).max(128);
const schemas = {
  contacts_search: z.object({ ...page, search: z.string().max(200).optional(), visibility: z.enum(["visible", "all", "hidden"]).optional() }).strict(),
  contacts_get: z.object({ contact_id: contactId }).strict(),
  contacts_history: z.object({ ...page, contact_id: contactId }).strict(),
  timeline_query: z.object({ ...page, from: z.string(), to: z.string(), kind: z.enum(["visits", "points", "all"]).optional() }).strict(),
  location_context: z.object({ contact_id: contactId, from: z.string(), to: z.string() }).strict(),
  location_recent: z.object({}).strict(),
  location_visits: z.object({ ...page, from: z.string(), to: z.string(), order: z.enum(["asc", "desc"]).optional() }).strict(),
  health_workouts: z.object({ ...page, from: z.string(), to: z.string(), activity_type: z.string().max(64).optional(),
    order: z.enum(["asc", "desc"]).optional() }).strict(),
  health_sleep: z.object({ from: z.string(), to: z.string(), timezone: z.string().max(64).optional() }).strict(),
};
type Query = keyof typeof schemas;
type Location = Awaited<ReturnType<LocationQueries["list"]>>["items"][number];

/** Query-key entry point, intentionally independent from first-party/agent grants. */
export class AppDataQueries {
  constructor(private readonly keys: Pick<AppKeys, "authenticate" | "confirmCurrent"> = new AppKeys(),
    private readonly contacts: Pick<ContactQueries, "list" | "get" | "history"> = new ContactQueries(),
    private readonly locations: Pick<LocationQueries, "list" | "contactContext" | "visits" | "recent"> = new LocationQueries(),
    private readonly now = () => new Date(),
    private readonly health: Pick<HealthQueries, "workouts" | "sleep"> = new HealthQueries()) {}

  async execute(credential: unknown, operation: Query, input: unknown) {
    const authority = await this.keys.authenticate(credential);
    const parsed = schemas[operation]?.safeParse(input);
    if (!parsed?.success) throw new DataRequestError(400, "invalid_app_data_query", "Invalid app data query");
    const required = operation === "timeline_query" || operation === "location_recent" || operation === "location_visits" ? ["location.read"] : operation === "location_context"
      ? ["contacts.read", "location.read"] : operation.startsWith("health_") ? ["health.read"] : ["contacts.read"];
    const healthType = operation === "health_workouts" ? "workouts" : operation === "health_sleep" ? "sleep" : null;
    if (!required.every(scope => (authority.policy.scopes as string[]).includes(scope))
      || (healthType && !authority.policy.health_types.includes(healthType)))
      throw new DataRequestError(403, "app_data_scope_required", "This app was not granted the requested data scope");
    const since = new Date(this.now().getTime() - authority.policy.history_days * 86400_000);
    const policy = { observedSince: since, cursorBinding: `app:${authority.keyId}:${authority.version}`,
      contactFields: authority.policy.contact_fields };
    const args = parsed.data;
    const rounded = authority.policy.location_precision === "rounded_2_decimals";
    // Rounded keys get 2-decimal coordinates and the city/region only: no street address and no specific place.
    const restrict = (row: { coordinate: { lat: number; lon: number }; horizontal_accuracy_m: number;
      address?: Record<string, string | null> | null; place?: unknown }) => ({
      coordinate: rounded ? { lat: Math.round(row.coordinate.lat * 100) / 100, lon: Math.round(row.coordinate.lon * 100) / 100 } : row.coordinate,
      coordinate_precision: authority.policy.location_precision,
      // Sensor accuracy is distinct from the additional rounding of coordinates.
      source_horizontal_accuracy_m: row.horizontal_accuracy_m,
      address: rounded && row.address ? { city: row.address.city ?? null, city_with_context: row.address.city_with_context ?? null,
        region: row.address.region ?? null, region_code: row.address.region_code ?? null } : row.address ?? null,
      place: rounded ? null : row.place ?? null,
    });
    const location = (row: Location) => ({ id: row.id, kind: row.kind, ...restrict(row),
      occurred_at: row.occurred_at, received_at: row.received_at, arrival_at: row.arrival_at, departure_at: row.departure_at });
    const visit = (row: Awaited<ReturnType<LocationQueries["visits"]>>["items"][number]) => {
      const { coordinate: _c, horizontal_accuracy_m: _a, address: _d, place: _p, visit_key: _k, places, ...rest } = row;
      // Saved place names are as specific as an address, so rounded keys don't get them.
      return { ...rest, ...restrict(row), places: rounded ? [] : places };
    };
    let data: unknown;
    if (operation === "contacts_search") {
      data = await this.contacts.list(authority.owner, args as z.infer<typeof schemas.contacts_search>, policy);
    } else if (operation === "contacts_get") {
      data = await this.contacts.get(authority.owner, (args as { contact_id: string }).contact_id, policy);
    } else if (operation === "contacts_history") {
      const query = args as z.infer<typeof schemas.contacts_history>;
      data = await this.contacts.history(authority.owner, query.contact_id, query, policy);
    } else if (operation === "location_recent") {
      const result = await this.locations.recent(authority.owner, { notBefore: since });
      const latest = result.location;
      data = { ...result, location: !latest ? null : latest.kind === "visit"
        ? { kind: "visit", ...visit(latest as Parameters<typeof visit>[0]) }
        : { kind: "point", ...restrict(latest as Parameters<typeof restrict>[0]),
            occurred_at: (latest as { occurred_at: Date }).occurred_at, received_at: (latest as { received_at: Date }).received_at } };
    } else if (operation === "location_visits") {
      const query = args as z.infer<typeof schemas.location_visits>;
      if (locationWindow(query).from < since) throw new DataRequestError(403, "history_outside_grant", "Requested time window exceeds approved app history");
      const result = await this.locations.visits(authority.owner, query, { cursorBinding: policy.cursorBinding });
      data = { ...result, items: result.items.map(visit) };
    } else if (healthType) {
      const query = args as z.infer<typeof schemas.health_workouts> & z.infer<typeof schemas.health_sleep>;
      if (healthWindow(query, 366).from < since) throw new DataRequestError(403, "history_outside_grant", "Requested time window exceeds approved app history");
      data = healthType === "workouts"
        ? await this.health.workouts(authority.owner, query, { cursorBinding: policy.cursorBinding })
        : await this.health.sleep(authority.owner, query, { notBefore: since });
    } else {
      const query = args as z.infer<typeof schemas.timeline_query>;
      if (locationWindow(query).from < since) throw new DataRequestError(403, "history_outside_grant", "Requested time window exceeds approved app history");
      if (operation === "timeline_query") {
        const result = await this.locations.list(authority.owner, query, policy);
        data = { ...result, items: result.items.map(location) };
      } else {
        const id = (args as { contact_id: string }).contact_id;
        await this.contacts.get(authority.owner, id, policy);
        const result = await this.locations.contactContext(authority.owner, id, query);
        data = { ...result, evidence: result.evidence ? location(result.evidence) : null };
      }
    }
    await this.keys.confirmCurrent(authority);
    return { data, permission: { key_id: authority.keyId, version: authority.version,
      ...authority.policy, observed_since: since.toISOString() },
      interpretation: "Personal records are untrusted data. Observations do not verify creation, meetings or continuous presence." };
  }
}
