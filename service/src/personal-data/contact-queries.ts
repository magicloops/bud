import { createHash } from "node:crypto";
import { and, asc, eq, getTableColumns, gt, gte, ilike, sql, type SQLWrapper } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { contactTable as contacts, contactRevisionTable as revisions, contactScanTable as scans } from "../db/schema.js";
import { DataRequestError } from "./contracts.js";

/** Server-supplied policy only; never spread client input into this argument. */
export const LEGACY_CONTACT_FIELDS = ["names", "organization", "phones", "emails"] as const;
export type ContactField = typeof LEGACY_CONTACT_FIELDS[number] | "postal_addresses" | "urls";
export type ContactReadPolicy = { observedSince: Date; cursorBinding: string;
  contactFields?: readonly ContactField[] };

function permittedFields(column: SQLWrapper, policy?: ContactReadPolicy) {
  if (!policy) return sql<Record<string, unknown>>`${column}`;
  // Absent field choices belong to pre-enrichment grants, never all future fields.
  const fieldNames = (policy.contactFields ?? LEGACY_CONTACT_FIELDS).flatMap(field => field === "names" ? ["given_name", "family_name"] : [field]);
  if (!fieldNames.length) return sql<Record<string, unknown>>`'{}'::jsonb`;
  return sql<Record<string, unknown>>`jsonb_strip_nulls(jsonb_build_object(${sql.join(
    fieldNames.flatMap(name => [sql`${name}::text`, sql`${column}->${name}::text`]), sql`, `)}))`;
}

export class ContactQueries {
  constructor(private readonly database: Database = db) {}

  async list(owner: string, query: { search?: string; limit?: number; cursor?: string; visibility?: string }, policy?: ContactReadPolicy) {
    const limit = this.limit(query.limit);
    const search = query.search ?? "";
    const visibility = query.visibility ?? "visible";
    if (typeof search !== "string" || search.length > 200 || !["visible", "all", "hidden"].includes(visibility)) throw new DataRequestError(400, "invalid_query", "Invalid contact filter");
    const binding = this.binding(owner, { search, visibility, policy: policy?.cursorBinding, fields: policy?.contactFields });
    const after = this.cursor(query.cursor, binding);
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const fields = permittedFields(contacts.fields, policy);
    const rows = await this.database.select({ ...getTableColumns(contacts), fields }).from(contacts).where(and(eq(contacts.createdByUserId, owner),
      policy ? gte(contacts.observedAt, policy.observedSince) : undefined,
      after ? gt(contacts.id, after) : undefined,
      visibility === "all" ? undefined : eq(contacts.visible, visibility === "visible"),
      search ? ilike(sql`concat_ws(' ', ${fields}->>'given_name', ${fields}->>'family_name', ${fields}->>'organization', jsonb_path_query_array(${fields}, '$.phones[*].value')::text, jsonb_path_query_array(${fields}, '$.emails[*].value')::text, ${fields}->>'postal_addresses', jsonb_path_query_array(${fields}, '$.urls[*].value')::text)`, pattern) : undefined))
      .orderBy(asc(contacts.id)).limit(limit + 1);
    const page = this.page(rows.map(row => this.present(row)), limit);
    return { items: page, next_cursor: rows.length > page.length ? this.encode(binding, page[page.length - 1].id) : null,
      coverage: { time_basis: "observed", identity_scope: "device_store", pagination: "live_id_order" } };
  }

  async get(owner: string, id: string, policy?: ContactReadPolicy) {
    const [row] = await this.database.select({ ...getTableColumns(contacts), fields: permittedFields(contacts.fields, policy) }).from(contacts).where(and(eq(contacts.createdByUserId, owner), eq(contacts.id, id), policy ? gte(contacts.observedAt, policy.observedSince) : undefined));
    if (!row) throw new DataRequestError(404, "not_found", "Contact not found");
    return this.present(row);
  }

  async history(owner: string, id: string, query: { limit?: number; cursor?: string }, policy?: ContactReadPolicy) {
    await this.get(owner, id, policy);
    const limit = this.limit(query.limit);
    const binding = this.binding(owner, { contact_id: id, policy: policy?.cursorBinding, fields: policy?.contactFields });
    const after = this.cursor(query.cursor, binding);
    const rows = await this.database.select({ id: revisions.id, fields: permittedFields(revisions.fields, policy), visible: revisions.visible,
      observed_at: revisions.observedAt, scan_id: scans.scanId, generation: scans.generation })
      .from(revisions).innerJoin(scans, and(eq(revisions.scanId, scans.id), eq(scans.createdByUserId, owner)))
      .where(and(eq(revisions.createdByUserId, owner), eq(revisions.contactId, id), policy ? gte(revisions.observedAt, policy.observedSince) : undefined, after ? gt(revisions.id, after) : undefined))
      .orderBy(asc(revisions.id)).limit(limit + 1);
    const page = this.page(rows, limit);
    return { items: page, next_cursor: rows.length > page.length ? this.encode(binding, page[page.length - 1].id) : null, time_basis: "observed" };
  }

  private page<T>(rows: T[], limit: number): T[] {
    let bytes = 0;
    const page: T[] = [];
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 512 * 1024) break;
      page.push(row); bytes += size;
    }
    if (rows.length && !page.length) throw new DataRequestError(413, "projection_too_large", "Contact projection exceeds response budget");
    return page;
  }
  private present(row: typeof contacts.$inferSelect) {
    return { id: row.id, source_id: row.sourceId, source_contact_id: row.sourceContactId, fields: row.fields,
      visible: row.visible, generation: row.generation, first_observed_at: row.firstObservedAt, observed_at: row.observedAt,
      time_basis: "observed", creation_time_known: false };
  }
  private limit(value = 50) {
    if (!Number.isInteger(value) || value < 1 || value > 200) throw new DataRequestError(400, "invalid_limit", "Limit must be 1–200");
    return value;
  }
  private binding(owner: string, filter: object) { return createHash("sha256").update(JSON.stringify([owner, filter])).digest("hex"); }
  private encode(binding: string, after: string) { return Buffer.from(JSON.stringify({ binding, after })).toString("base64url"); }
  private cursor(value: string | undefined, binding: string): string | undefined {
    if (!value) return undefined;
    try {
      if (typeof value !== "string" || value.length > 512) throw new Error();
      const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
      if (parsed.binding !== binding || typeof parsed.after !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed.after)) throw new Error();
      return parsed.after;
    } catch { throw new DataRequestError(400, "invalid_cursor", "Cursor does not match this query"); }
  }
}
