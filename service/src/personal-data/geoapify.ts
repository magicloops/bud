import { config } from "../config.js";
import { DataRequestError } from "./contracts.js";

/**
 * Place lookup from Geoapify (Phase 11): reverse geocoding and nearby points of interest for
 * visit names, and search for the pin editors. Unlike Apple Maps data, results may be stored
 * indefinitely and shown on any map, with OpenStreetMap's attribution (and Geoapify's on the free
 * plan). Every call is one credit (a visit name is three: an address and two place groups); `DailyCredits` keeps us under the plan's daily allowance.
 */
export const GEOAPIFY_ATTRIBUTION = "Powered by Geoapify · © OpenStreetMap contributors";

/** Stored with names in `location_visit_name.address` (the phone's MapKit lookups used the same keys). */
export type NamedAddress = { full: string | null; short: string | null; city: string | null; city_with_context: string | null;
  region: string | null; region_code: string | null };
export type NearbyPlace = { name: string; category: string | null; coordinate: { lat: number; lon: number }; distance_m: number };
export type SearchResult = { name: string | null; address: string | null; coordinate: { lat: number; lon: number }; category: string | null };

const BASE = "https://api.geoapify.com";
const TIMEOUT_MS = 8_000;
/** Points of interest further than this from a visit aren't its likely place. */
export const NEARBY_PLACE_RADIUS_M = 100;
/**
 * The categories a visit's likely place can come from (places people go, not roads or areas), in two
 * requests. Geoapify silently drops broad categories such as `catering` and `commercial` from a list
 * that also has `tourism`, `accommodation`, `airport` or most `sport.*` ones (November 6:
 * `catering,tourism` returned exactly the tourism-only results, at any limit, with or without
 * proximity bias, and by GET or POST), while each group mixes within itself. See
 * the Phase 11 plan. `sport` itself found nothing nearby where `sport.fitness` did, so the
 * sport subcategories are listed.
 */
export const PLACE_CATEGORY_GROUPS = [
  ["catering", "commercial", "education", "entertainment", "healthcare", "office", "service", "religion", "public_transport",
    "activity", "leisure", "childcare", "rental", "pet", "sport.fitness"],
  ["tourism", "accommodation", "airport", "sport.sports_centre", "sport.stadium", "sport.swimming_pool", "sport.pitch",
    "sport.track", "sport.ice_rink", "sport.dive_centre", "sport.horse_riding"],
] as const;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Credits spent per UTC day, in this process (the service runs one instance). */
export class DailyCredits {
  private day = "";
  private used = 0;
  constructor(private readonly limit: number, private readonly now = () => new Date()) {}
  take(): boolean {
    const day = this.now().toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.used = 0; }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

/** `format=json` answers `{ results: [...] }`; GeoJSON answers `{ features: [{ properties }] }`. */
function items(body: unknown): Record<string, unknown>[] {
  const root = record(body);
  const rows = Array.isArray(root?.results) ? root.results : Array.isArray(root?.features) ? root.features.map(feature => record(feature)?.properties) : [];
  return rows.map(record).filter((row): row is Record<string, unknown> => row !== null);
}

/** Geoapify's address in the stored shape. `short` is the street address and the city, like Apple's:
 * built from the house number and street, since the first line can be a business or an intersection
 * ("Fort Help Mission", "26th Street & Mission Street"). OpenStreetMap lists several house numbers
 * as "3328;3330", shown as a range. */
export function namedAddress(row: Record<string, unknown>): NamedAddress | null {
  const full = string(row.formatted), city = string(row.city), street = string(row.street);
  const numbers = string(row.housenumber)?.split(";").map(part => part.trim()).filter(Boolean) ?? [];
  const house = numbers.length > 1 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers[0] ?? null;
  const line1 = street ? (house ? `${house} ${street}` : street) : string(row.address_line1);
  if (!full && !line1) return null;
  const state = string(row.state_code) ?? string(row.state);
  return { full: full?.replace(/(\d+);(\d+)/g, "$1–$2") ?? null, short: line1 && city && line1 !== city ? `${line1}, ${city}` : line1 ?? city, city,
    city_with_context: city ? (state ? `${city}, ${state}` : city) : null, region: string(row.country),
    region_code: string(row.country_code)?.toUpperCase() ?? null };
}

export class Geoapify {
  constructor(private readonly key: string | null = config.geoapifyApiKey,
    private readonly credits = new DailyCredits(config.geoapifyDailyCredits),
    private readonly fetcher: Fetch = (url, init) => fetch(url, init)) {}

  get available() { return Boolean(this.key); }

  /** One credit, or null when there's no key, the day's credits are spent, or the call fails. */
  private async get(path: string, params: Record<string, string>): Promise<unknown | null> {
    if (!this.key || !this.credits.take()) return null;
    const url = `${BASE}${path}?${new URLSearchParams({ ...params, apiKey: this.key })}`;
    try {
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }

  /** The nearest address to a coordinate. */
  async reverse(lat: number, lon: number): Promise<NamedAddress | null> {
    const body = await this.get("/v1/geocode/reverse", { lat: String(lat), lon: String(lon), format: "json", lang: "en", limit: "1" });
    const [first] = items(body);
    return first ? namedAddress(first) : null;
  }

  /**
   * The nearest named point of interest within `NEARBY_PLACE_RADIUS_M`: both category groups, merged
   * by distance (up to 20 places each, one credit each). Null when there's none; undefined when a
   * request failed, so the answer is unknown rather than "nothing nearby".
   */
  async nearbyPlace(lat: number, lon: number): Promise<NearbyPlace | null | undefined> {
    const bodies = [];
    for (const group of PLACE_CATEGORY_GROUPS) {
      const body = await this.get("/v2/places", { categories: group.join(","), filter: `circle:${lon},${lat},${NEARBY_PLACE_RADIUS_M}`,
        bias: `proximity:${lon},${lat}`, conditions: "named", limit: "20", lang: "en" });
      if (body === null) return undefined;
      bodies.push(body);
    }
    const seen = new Set<string>();
    // Bus stops are named by their intersection ("26th Street & Mission Street"), not a place to be.
    const nearest = bodies.flatMap(items).filter(row => !(Array.isArray(row.categories) && row.categories.includes("public_transport.bus")))
      .filter(row => { const id = string(row.place_id); if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; })
      .map(row => ({ name: string(row.name), lat: number(row.lat), lon: number(row.lon),
        distance: number(row.distance), category: Array.isArray(row.categories) ? string(row.categories[0]) : null }))
      .filter(row => row.name && row.lat !== null && row.lon !== null && row.distance !== null && row.distance <= NEARBY_PLACE_RADIUS_M)
      .sort((a, b) => a.distance! - b.distance!)[0];
    return nearest ? { name: nearest.name!, category: nearest.category, coordinate: { lat: nearest.lat!, lon: nearest.lon! },
      distance_m: nearest.distance! } : null;
  }

  /** Addresses and places matching typed text, nearest first when `near` is given. */
  async search(text: string, near?: { lat: number; lon: number }): Promise<SearchResult[]> {
    if (!this.key) throw new DataRequestError(503, "place_lookup_unavailable", "Place search isn't configured on this server");
    const body = await this.get("/v1/geocode/autocomplete", { text, format: "json", lang: "en", limit: "8",
      ...(near ? { bias: `proximity:${near.lon},${near.lat}` } : {}) });
    if (body === null) throw new DataRequestError(503, "place_lookup_failed", "Place search is unavailable right now; try again", true);
    return items(body).flatMap(row => {
      const lat = number(row.lat), lon = number(row.lon);
      if (lat === null || lon === null) return [];
      // A street or address result's `name` is the street; only a business or other amenity has its own.
      return [{ name: row.result_type === "amenity" ? string(row.name) : null, address: string(row.formatted), coordinate: { lat, lon },
        category: string(row.category) }];
    });
  }
}
