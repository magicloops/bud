import { z } from "zod";
import { AppKeys } from "./app-keys.js";
import { ContactQueries } from "./contact-queries.js";
import { LocationQueries, locationWindow } from "./location.js";
import { DataRequestError } from "./contracts.js";

const page = { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(600).optional() };
const contactId = z.string().min(1).max(128);
const schemas = {
  contacts_search: z.object({ ...page, search: z.string().max(200).optional(), visibility: z.enum(["visible", "all", "hidden"]).optional() }).strict(),
  contacts_get: z.object({ contact_id: contactId }).strict(),
  contacts_history: z.object({ ...page, contact_id: contactId }).strict(),
  timeline_query: z.object({ ...page, from: z.string(), to: z.string() }).strict(),
  location_context: z.object({ contact_id: contactId, from: z.string(), to: z.string() }).strict(),
};
type Query = keyof typeof schemas;
type Location = Awaited<ReturnType<LocationQueries["list"]>>["items"][number];

/** Query-key entry point, intentionally independent from first-party/agent grants. */
export class AppDataQueries {
  constructor(private readonly keys: Pick<AppKeys, "authenticate" | "confirmCurrent"> = new AppKeys(),
    private readonly contacts: Pick<ContactQueries, "list" | "get" | "history"> = new ContactQueries(),
    private readonly locations: Pick<LocationQueries, "list" | "contactContext"> = new LocationQueries(),
    private readonly now = () => new Date()) {}

  async execute(credential: unknown, operation: Query, input: unknown) {
    const authority = await this.keys.authenticate(credential);
    const parsed = schemas[operation]?.safeParse(input);
    if (!parsed?.success) throw new DataRequestError(400, "invalid_app_data_query", "Invalid app data query");
    const required = operation === "timeline_query" ? ["location.read"] : operation === "location_context"
      ? ["contacts.read", "location.read"] : ["contacts.read"];
    if (!required.every(scope => authority.policy.scopes.includes(scope as "contacts.read" | "location.read")))
      throw new DataRequestError(403, "app_data_scope_required", "This app was not granted the requested data scope");
    const since = new Date(this.now().getTime() - authority.policy.history_days * 86400_000);
    const policy = { observedSince: since, cursorBinding: `app:${authority.keyId}:${authority.version}`,
      contactFields: authority.policy.contact_fields };
    const args = parsed.data;
    const location = (row: Location) => ({ id: row.id, kind: row.kind,
      coordinate: authority.policy.location_precision === "rounded_2_decimals" ? {
        lat: Math.round(row.coordinate.lat * 100) / 100, lon: Math.round(row.coordinate.lon * 100) / 100,
      } : row.coordinate,
      coordinate_precision: authority.policy.location_precision,
      // Sensor accuracy is distinct from the additional rounding of coordinates.
      source_horizontal_accuracy_m: row.horizontal_accuracy_m,
      occurred_at: row.occurred_at, received_at: row.received_at, arrival_at: row.arrival_at, departure_at: row.departure_at });
    let data: unknown;
    if (operation === "contacts_search") {
      data = await this.contacts.list(authority.owner, args as z.infer<typeof schemas.contacts_search>, policy);
    } else if (operation === "contacts_get") {
      data = await this.contacts.get(authority.owner, (args as { contact_id: string }).contact_id, policy);
    } else if (operation === "contacts_history") {
      const query = args as z.infer<typeof schemas.contacts_history>;
      data = await this.contacts.history(authority.owner, query.contact_id, query, policy);
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
