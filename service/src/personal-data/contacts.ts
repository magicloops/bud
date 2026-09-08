import { createHash } from "node:crypto";
import { isRecord, validIdentifier } from "./contracts.js";

export type ContactScanMode = "baseline" | "incremental" | "access_change" | "resync";
export type ContactFields = {
  given_name: string; family_name: string; organization: string;
  phones: { label: string; value: string }[];
  emails: { label: string; value: string }[];
};
export type ExpandedContactFields = ContactFields & {
  postal_addresses: { label: string; street: string; city: string; sub_administrative_area: string;
    state: string; postal_code: string; country: string; iso_country_code: string }[];
  urls: { label: string; value: string }[];
};
export type ContactScanContext = {
  // Absent means v1, including immutable payloads stored by earlier processors.
  payload_version?: 2;
  repair?: true;
  contact_store_id: string; scan_id: string; generation: number; previous_generation: number;
  scan_mode: ContactScanMode; observed_at: string; previous_observed_at: string | null;
  time_basis: "observed"; authorization: string;
};
export type ContactRecord = ContactScanContext & {
  kind: "record"; source_contact_id: string; change: "upsert" | "no_longer_visible";
  newly_observed: boolean; contact?: ContactFields | ExpandedContactFields;
};
export type ContactManifest = ContactScanContext & {
  kind: "manifest"; expected_event_count: number; event_ids_sha256: string;
};
export type ContactPayload = ContactRecord | ContactManifest;

const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length <= 4096;

function fields(value: unknown): value is ContactFields {
  if (!isRecord(value) || Object.keys(value).some(key => !["given_name", "family_name", "organization", "phones", "emails"].includes(key))) return false;
  const labels = (items: unknown) => Array.isArray(items) && items.length <= 1000 && items.every(item =>
    isRecord(item) && Object.keys(item).every(key => key === "label" || key === "value") && text(item.label) && text(item.value));
  return text(value.given_name) && text(value.family_name) && text(value.organization) && labels(value.phones) && labels(value.emails);
}

/** V2 field foundation only; v1 processing never accepts or drops these keys. */
export function parseExpandedContactFields(value: unknown): ExpandedContactFields | null {
  if (!isRecord(value)) return null;
  const { postal_addresses, urls, ...legacy } = value;
  if (!fields(legacy)) return null;
  const addressKeys = ["label", "street", "city", "sub_administrative_area", "state", "postal_code", "country", "iso_country_code"];
  if (!Array.isArray(postal_addresses) || postal_addresses.length > 1000 || !postal_addresses.every(address =>
    isRecord(address) && Object.keys(address).length === addressKeys.length && addressKeys.every(key => text(address[key])))) return null;
  if (!Array.isArray(urls) || urls.length > 1000 || !urls.every(url => isRecord(url) &&
    Object.keys(url).length === 2 && text(url.label) && text(url.value))) return null;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 240 * 1024) return null;
  return value as ExpandedContactFields;
}

/** Processing validation is separate from the durable raw-ingestion ACK. */
export function parseContactPayload(eventType: string, value: unknown, options: { allowExpanded?: boolean } = {}): ContactPayload | null {
  const type = /^contacts\.(repair_)?(record|scan)\.v([12])$/.exec(eventType);
  if (!type) return null;
  const repair = !!type[1];
  const expanded = type[3] === "2";
  if (expanded && !options.allowExpanded) return null;
  if (!isRecord(value) || value.payload_version !== (expanded ? 2 : 1) || (repair && value.scan_mode !== "resync")) return null;
  if (!uuid(value.contact_store_id) || !uuid(value.scan_id)
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
    || value.previous_generation !== Number(value.generation) - 1
    || !["baseline", "incremental", "access_change", "resync"].includes(String(value.scan_mode))
    || !timestamp(value.observed_at) || (value.previous_observed_at !== null && !timestamp(value.previous_observed_at))
    || value.time_basis !== "observed" || !validIdentifier(value.authorization)) return null;
  if ((value.generation === 1) !== (value.scan_mode === "baseline")
    || (value.generation === 1) !== (value.previous_observed_at === null)) return null;
  const context: ContactScanContext = {
    ...(expanded ? { payload_version: 2 as const } : {}),
    ...(repair ? { repair: true as const } : {}),
    contact_store_id: value.contact_store_id, scan_id: value.scan_id,
    generation: Number(value.generation), previous_generation: Number(value.previous_generation),
    scan_mode: value.scan_mode as ContactScanMode, observed_at: value.observed_at,
    previous_observed_at: value.previous_observed_at as string | null,
    time_basis: "observed", authorization: value.authorization,
  };
  if (type[2] === "scan") {
    if (!Number.isSafeInteger(value.expected_event_count) || Number(value.expected_event_count) < 0
      || Number(value.expected_event_count) > 20_000 || typeof value.event_ids_sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(value.event_ids_sha256)) return null;
    return { ...context, kind: "manifest", expected_event_count: Number(value.expected_event_count), event_ids_sha256: value.event_ids_sha256 };
  }
  if (!validIdentifier(value.source_contact_id) || !["upsert", "no_longer_visible"].includes(String(value.change))
    || typeof value.newly_observed !== "boolean") return null;
  if (value.newly_observed && (value.scan_mode !== "incremental" || value.change !== "upsert")) return null;
  if (value.change === "upsert" ? !(expanded ? parseExpandedContactFields(value.contact) : fields(value.contact)) : value.contact !== undefined) return null;
  return { ...context, kind: "record", source_contact_id: value.source_contact_id,
    change: value.change as ContactRecord["change"], newly_observed: value.newly_observed,
    ...(value.change === "upsert" ? { contact: value.contact as ContactFields | ExpandedContactFields } : {}) };
}

export function contactManifestDigest(eventIDs: string[]): string {
  return createHash("sha256").update([...eventIDs].sort().join("\n"), "utf8").digest("hex");
}

/** Caller must scope rows by owner, installation and epoch before supplying them. */
export function verifyContactScan(manifest: ContactManifest, records: { eventID: string; payload: ContactRecord }[]): boolean {
  if (records.length !== manifest.expected_event_count || new Set(records.map(row => row.eventID)).size !== records.length
    || new Set(records.map(row => row.payload.source_contact_id)).size !== records.length) return false;
  const keys = ["contact_store_id", "scan_id", "generation", "previous_generation", "scan_mode", "observed_at", "previous_observed_at", "time_basis", "authorization"] as const;
  return records.every(row => uuid(row.eventID) && (row.payload.payload_version ?? 1) === (manifest.payload_version ?? 1)
    && !!row.payload.repair === !!manifest.repair && keys.every(key => row.payload[key] === manifest[key]))
    && contactManifestDigest(records.map(row => row.eventID)) === manifest.event_ids_sha256;
}
