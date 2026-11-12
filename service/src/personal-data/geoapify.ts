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
/** `area` is the neighbourhood or district (Phase 12). */
export type NamedAddress = { full: string | null; short: string | null; area?: string | null; city: string | null; city_with_context: string | null;
  region: string | null; region_code: string | null };
export type NearbyPlace = { name: string; place_id?: string | null; category: string | null; category_label?: string | null; cuisine?: string | null;
  coordinate: { lat: number; lon: number }; distance_m: number };
/** A place found for the agent (Phase 13): a nearby place plus what the Places API knows. */
export type FoundPlace = Omit<NearbyPlace, "place_id"> & { place_id: string | null; categories: string[]; opening_hours: string | null };
export type PlaceDetails = { place_id: string; name: string | null; address: string | null; coordinate: { lat: number; lon: number } | null;
  categories: string[]; category: string | null; category_label: string | null; cuisine: string | null; opening_hours: string | null;
  website: string | null; phone: string | null; brand: string | null; takeaway: boolean | null; delivery: boolean | null;
  time_zone: string | null };
export type SearchResult = { name: string | null; address: string | null; coordinate: { lat: number; lon: number }; category: string | null };

const BASE = "https://api.geoapify.com";
const TIMEOUT_MS = 8_000;
/** Points of interest further than this from a visit aren't its likely place; a coarse visit widens
 * the circle to its accuracy, up to `NEARBY_PLACE_MAX_RADIUS_M` (Phase 12). */
export const NEARBY_PLACE_RADIUS_M = 100;
export const NEARBY_PLACE_MAX_RADIUS_M = 200;
/** Candidates kept for a visit not at a saved place (Phase 12). */
export const NEARBY_PLACES_KEPT = 5;
export const nearbyRadius = (accuracyM: number) => Math.round(Math.max(NEARBY_PLACE_RADIUS_M, Math.min(accuracyM, NEARBY_PLACE_MAX_RADIUS_M)));

/** Readable labels for the categories a likely place comes from, most specific first. */
const CATEGORY_LABELS: Array<[string, string]> = [
  ["catering.cafe", "café"], ["catering.restaurant", "restaurant"], ["catering.fast_food", "fast food"], ["catering.bar", "bar"],
  ["catering.pub", "pub"], ["catering.ice_cream", "ice cream"], ["catering", "food and drink"],
  ["commercial.supermarket", "supermarket"], ["commercial.convenience", "convenience store"], ["commercial", "shop"],
  ["healthcare.pharmacy", "pharmacy"], ["healthcare.hospital", "hospital"], ["healthcare", "healthcare"],
  ["education.school", "school"], ["education.university", "university"], ["education", "education"],
  ["leisure.park", "park"], ["leisure", "leisure"], ["sport.fitness", "gym"], ["sport.stadium", "stadium"],
  ["sport.swimming_pool", "pool"], ["sport", "sports"], ["accommodation.hotel", "hotel"], ["accommodation", "lodging"],
  ["tourism.attraction", "attraction"], ["tourism", "sights"], ["public_transport.train", "train station"],
  ["public_transport.subway", "subway station"], ["public_transport", "transit"], ["religion", "place of worship"],
  ["office", "office"], ["service", "service"], ["entertainment", "entertainment"], ["childcare", "childcare"],
  ["rental", "rental"], ["pet", "pet services"], ["activity", "activity"], ["airport", "airport"],
];

/** Categories Geoapify uses as conditions rather than kinds of place. */
const CONDITION_CATEGORIES = ["building", "wheelchair", "internet_access", "vegetarian", "vegan", "access", "access_limited", "fee",
  "no_fee", "dogs", "no_dogs", "named", "halal", "kosher", "organic", "gluten_free", "sugar_free", "egg_free", "soy_free"];

/** A place's most specific kind (`catering.restaurant.mexican` over `catering`), ignoring conditions. */
export function mostSpecificCategory(categories: readonly string[]): string | null {
  const kinds = categories.filter(category => !CONDITION_CATEGORIES.some(condition => category === condition || category.startsWith(condition + ".")));
  return [...kinds].sort((a, b) => b.split(".").length - a.split(".").length)[0] ?? categories[0] ?? null;
}

/** Which request a category belongs in: Geoapify drops broad categories from a list that mixes the
 * two groups (`PLACE_CATEGORY_GROUPS`). */
export function categoryGroup(category: string): 0 | 1 {
  return /^(tourism|accommodation|airport)(\.|$)/.test(category) || (/^sport(\.|$)/.test(category) && !category.startsWith("sport.fitness")) ? 1 : 0;
}

/** A place's category for display: its most specific one we label (the first array item isn't
 * necessarily the relevant one), else the first, as words. */
export function categoryLabel(categories: readonly string[]): string | null {
  for (const [prefix, label] of CATEGORY_LABELS)
    if (categories.some(category => category === prefix || category.startsWith(prefix + "."))) return label;
  return categories[0]?.split(".").at(-1)?.replaceAll("_", " ") ?? null;
}
/**
 * The categories a visit's likely place can come from (places people go, not roads or areas), in two
 * requests. Geoapify silently drops broad categories such as `catering` and `commercial` from a list
 * that also has `tourism`, `accommodation`, `airport` or most `sport.*` ones (November 6:
 * `catering,tourism` returned exactly the tourism-only results, at any limit, with or without
 * proximity bias, and by GET or POST), while each group mixes within itself. See
 * the Phase 11 plan. `sport` itself found nothing nearby where `sport.fitness` did, so the
 * sport subcategories are listed.
 */
/**
 * Not places someone stays, so never a visit's candidates (the agent's own searches still find
 * them): bus stops are named by their intersection ("26th Street & Mission Street"), and bike-share
 * docks crowded a cafe out of the five nearest on November 10.
 */
const NOT_A_STAY: readonly unknown[] = ["public_transport.bus", "rental.bicycle"];

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
    region_code: string(row.country_code)?.toUpperCase() ?? null, area: string(row.suburb) ?? string(row.district) ?? string(row.quarter) };
}

/** A Places API row as a place, or null without a name and position. */
function foundPlace(row: Record<string, unknown>): FoundPlace | null {
  const name = string(row.name), lat = number(row.lat), lon = number(row.lon), distance = number(row.distance);
  if (!name || lat === null || lon === null || distance === null) return null;
  const categories = Array.isArray(row.categories) ? row.categories.filter((c): c is string => typeof c === "string") : [];
  return { name, place_id: string(row.place_id), categories, category: mostSpecificCategory(categories), category_label: categoryLabel(categories),
    cuisine: string(record(row.catering)?.cuisine), opening_hours: string(row.opening_hours), coordinate: { lat, lon }, distance_m: distance };
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
   * The named points of interest within `radiusM`, nearest first, up to `NEARBY_PLACES_KEPT`: both
   * category groups, merged by distance and de-duplicated (up to 20 places each, one credit each).
   * Empty when there are none; undefined when a request failed, so the answer is unknown rather
   * than "nothing nearby".
   */
  async nearbyPlaces(lat: number, lon: number, radiusM = NEARBY_PLACE_RADIUS_M): Promise<NearbyPlace[] | undefined> {
    const bodies = [];
    for (const group of PLACE_CATEGORY_GROUPS) {
      const body = await this.get("/v2/places", { categories: group.join(","), filter: `circle:${lon},${lat},${radiusM}`,
        bias: `proximity:${lon},${lat}`, conditions: "named", limit: "20", lang: "en" });
      if (body === null) return undefined;
      bodies.push(body);
    }
    const seen = new Set<string>();
    return bodies.flatMap(items).filter(row => !(Array.isArray(row.categories) && row.categories.some(c => NOT_A_STAY.includes(c))))
      .filter(row => { const id = string(row.place_id); if (!id) return true; if (seen.has(id)) return false; seen.add(id); return true; })
      .flatMap(row => {
        const place = foundPlace(row);
        if (!place || place.distance_m > radiusM) return [];
        // Stored with the visit's name (Phase 12): the place_id lets the agent look up details.
        const { name, place_id, category, category_label, cuisine, coordinate, distance_m } = place;
        return [{ name, ...(place_id ? { place_id } : {}), category, category_label, ...(cuisine ? { cuisine } : {}), coordinate, distance_m }];
      })
      .sort((a, b) => a.distance_m - b.distance_m).slice(0, NEARBY_PLACES_KEPT);
  }

  /**
   * Places around a point for the agent (Phase 13), nearest first, up to `limit`. Given categories
   * are split by `categoryGroup` into one request per group present; none means both default groups.
   * `text` filters by name. Null when a request failed or there's no key.
   */
  async searchNearby(query: { lat: number; lon: number; radiusM: number; categories?: string[]; text?: string; limit?: number }): Promise<FoundPlace[] | null> {
    const groups = query.categories?.length
      ? [0, 1].map(group => query.categories!.filter(category => categoryGroup(category) === group)).filter(list => list.length)
      : PLACE_CATEGORY_GROUPS.map(group => [...group]);
    const bodies = [];
    for (const categories of groups) {
      const body = await this.get("/v2/places", { categories: categories.join(","), filter: `circle:${query.lon},${query.lat},${query.radiusM}`,
        bias: `proximity:${query.lon},${query.lat}`, conditions: "named", limit: "20", lang: "en", ...(query.text ? { name: query.text } : {}) });
      if (body === null) return null;
      bodies.push(body);
    }
    const seen = new Set<string>();
    return bodies.flatMap(items).filter(row => !(Array.isArray(row.categories) && row.categories.includes("public_transport.bus")))
      .map(foundPlace).filter((place): place is FoundPlace => place !== null && place.distance_m <= query.radiusM)
      .filter(place => !place.place_id || (!seen.has(place.place_id) && Boolean(seen.add(place.place_id))))
      .sort((a, b) => a.distance_m - b.distance_m).slice(0, query.limit ?? 10);
  }

  /** One place's details (one credit). Null when it failed or there's no key. */
  async placeDetails(placeId: string): Promise<PlaceDetails | null> {
    const body = await this.get("/v2/place-details", { id: placeId, features: "details", lang: "en" });
    const [row] = items(body);
    if (!row) return null;
    const categories = Array.isArray(row.categories) ? row.categories.filter((c): c is string => typeof c === "string") : [];
    const lat = number(row.lat), lon = number(row.lon);
    const flag = (value: unknown) => typeof value === "boolean" ? value : value === "yes" ? true : value === "no" ? false : null;
    return { place_id: placeId, name: string(row.name), address: string(row.formatted), coordinate: lat !== null && lon !== null ? { lat, lon } : null,
      categories, category: mostSpecificCategory(categories), category_label: categoryLabel(categories), cuisine: string(record(row.catering)?.cuisine),
      opening_hours: string(row.opening_hours), website: string(row.website), phone: string(record(row.contact)?.phone),
      brand: string(row.brand), takeaway: flag(record(row.facilities)?.takeaway ?? row.takeaway),
      delivery: flag(record(row.facilities)?.delivery ?? row.delivery),
      time_zone: string(record(row.timezone)?.name) };
  }

  /** The nearest of `nearbyPlaces`: null when there's none, undefined when unknown. */
  async nearbyPlace(lat: number, lon: number, radiusM = NEARBY_PLACE_RADIUS_M): Promise<NearbyPlace | null | undefined> {
    const places = await this.nearbyPlaces(lat, lon, radiusM);
    return places === undefined ? undefined : places[0] ?? null;
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
