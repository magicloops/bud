import { eq } from "drizzle-orm";
import { db, type Database } from "../db/client.js";
import { agentDataGrantTable as grants, dataOwnerStateTable as owners } from "../db/schema.js";
import { DataRequestError, isRecord } from "./contracts.js";

export type DataScope = "contacts.read" | "location.read";
export const DATA_SCOPES: DataScope[] = ["contacts.read", "location.read"];
const LEGACY_FIELDS = ["names", "organization", "phones", "emails"];
const CONTACT_FIELDS = [...LEGACY_FIELDS, "postal_addresses", "urls"];
export type AgentDataGrant = { scopes: string[]; version: number; history_days: number; updated_at: Date | null;
  consumer: string; fields: string[]; supported_contact_fields?: string[]; location_precision: string };
export class DataGrants {
  constructor(private readonly database: Omit<Database, "$client"> = db) {}
  /** Verify the deployed field-permission migration without reading personal data. */
  async verifyFieldSchema(): Promise<void> {
    await this.database.select({ fields: grants.contactFields }).from(grants).limit(0);
  }
  async get(owner: string): Promise<AgentDataGrant> {
    const [row] = await this.database.select().from(grants).where(eq(grants.createdByUserId, owner));
    return { scopes: row?.scopes ?? [], version: row?.version ?? 0, history_days: row?.historyDays ?? 90,
      updated_at: row?.updatedAt ?? null, consumer: "your_agents", fields: row?.contactFields ?? [...LEGACY_FIELDS],
      supported_contact_fields: [...CONTACT_FIELDS], location_precision: "as_collected" };
  }
  async update(owner: string, value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.scopes) || value.scopes.some(s => !DATA_SCOPES.includes(s as DataScope))
      || new Set(value.scopes).size !== value.scopes.length || !Number.isSafeInteger(value.version) || Number(value.version) < 0
      || !Number.isInteger(value.history_days) || Number(value.history_days) < 1 || Number(value.history_days) > 3650)
      throw new DataRequestError(400, "invalid_grant", "Provide unique read scopes, current version and history_days from 1 to 3650");
    if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > CONTACT_FIELDS.length
      || value.fields.some(field => typeof field !== "string" || !CONTACT_FIELDS.includes(field))
      || new Set(value.fields).size !== value.fields.length))
      throw new DataRequestError(400, "invalid_grant", "Provide unique supported contact fields");
    await this.database.transaction(async tx => {
      await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
      await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
      const [prior] = await tx.select().from(grants).where(eq(grants.createdByUserId, owner));
      if ((prior?.version ?? 0) !== value.version) throw new DataRequestError(409, "grant_conflict", "Permissions changed; reload before saving");
      const next = { scopes: value.scopes as string[], version: Number(value.version) + 1, historyDays: Number(value.history_days),
        contactFields: value.fields === undefined ? prior?.contactFields ?? [...LEGACY_FIELDS] : [...value.fields as string[]],
        updatedAt: new Date(), updatedByUserId: owner };
      if (prior) await tx.update(grants).set(next).where(eq(grants.createdByUserId, owner));
      else await tx.insert(grants).values({ createdByUserId: owner, ...next });
    });
    return this.get(owner);
  }
  async require(owner: string, scopes: DataScope[]) {
    const grant = await this.get(owner);
    if (!scopes.every(scope => grant.scopes.includes(scope))) throw new DataRequestError(403, "data_permission_required", "Approve agent data access in Personal data settings");
    return grant;
  }
}
