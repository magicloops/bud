import assert from "node:assert/strict";
import test from "node:test";
import { categoryGroup, categoryLabel, DailyCredits, Geoapify, mostSpecificCategory, namedAddress, nearbyRadius, PLACE_CATEGORY_GROUPS } from "./geoapify.js";

/** Responses recorded in Geoapify's documented shapes (no live calls in tests). */
const reverse = { results: [{ name: "26th Street", formatted: "3327 26th Street, San Francisco, CA 94110, United States of America",
  address_line1: "3327 26th Street", address_line2: "San Francisco, CA 94110, United States of America", housenumber: "3327",
  street: "26th Street", city: "San Francisco", state: "California", state_code: "CA", postcode: "94110",
  country: "United States", country_code: "us", lat: 37.749, lon: -122.4165, result_type: "building", distance: 6,
  datasource: { sourcename: "openstreetmap", attribution: "© OpenStreetMap contributors" } }] };
const places = { type: "FeatureCollection", features: [
  { properties: { name: "Far Café", categories: ["catering.cafe", "catering"], lat: 37.7495, lon: -122.417, distance: 64 } },
  { properties: { name: "Blue Bottle Coffee", categories: ["catering.cafe", "catering"], lat: 37.7491, lon: -122.4166, distance: 12 } },
  { properties: { categories: ["building"], lat: 37.749, lon: -122.4165, distance: 2 } },
  { properties: { name: "26th Street & Mission Street", categories: ["public_transport", "public_transport.bus"], lat: 37.749, lon: -122.4165, distance: 4 } },
  { properties: { name: "Bay Wheels", categories: ["rental", "rental.bicycle"], lat: 37.749, lon: -122.4165, distance: 6 } }] };
const autocomplete = { results: [
  { name: "Blue Bottle Coffee", formatted: "Blue Bottle Coffee, 66 Mint Street, San Francisco, CA 94103, United States of America",
    address_line1: "Blue Bottle Coffee", lat: 37.7824, lon: -122.4078, result_type: "amenity", category: "catering.cafe" },
  { name: "26th Street", formatted: "3327 26th Street, San Francisco, CA 94110, United States of America",
    address_line1: "3327 26th Street", lat: 37.749, lon: -122.4165, result_type: "building" }] };

/** `bodies` by path; the Places path can answer per category group (by its first category). */
const client = (bodies: Record<string, unknown>, credits = 100) => {
  const urls: string[] = [];
  const geoapify = new Geoapify("test-key", new DailyCredits(credits), async url => {
    urls.push(url);
    const { pathname, searchParams } = new URL(url);
    const body = bodies[`${pathname}?${searchParams.get("categories")?.split(",")[0]}`] ?? bodies[pathname];
    return body !== undefined ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 500, json: async () => ({}) };
  });
  return { geoapify, urls };
};

test("Geoapify names a coordinate in the stored address shape, and finds its nearest named place", async () => {
  assert.deepEqual(namedAddress(reverse.results[0]), { full: "3327 26th Street, San Francisco, CA 94110, United States of America",
    short: "3327 26th Street, San Francisco", city: "San Francisco", city_with_context: "San Francisco, CA",
    region: "United States", region_code: "US", area: null });
  assert.equal(namedAddress({ ...reverse.results[0], suburb: "Mission District" })?.area, "Mission District");
  // November 5 replay: the first line can be a business or an intersection; OpenStreetMap lists
  // house numbers as "3328;3330".
  assert.equal(namedAddress({ address_line1: "Fort Help Mission", housenumber: "3353", street: "26th Street", city: "San Francisco" })?.short,
    "3353 26th Street, San Francisco");
  assert.equal(namedAddress({ address_line1: "26th Street & Mission Street", street: "Mission Street", city: "San Francisco" })?.short,
    "Mission Street, San Francisco");
  assert.deepEqual([namedAddress({ formatted: "3328;3330 26th Street, San Francisco, CA", housenumber: "3328;3330", street: "26th Street",
    city: "San Francisco" })?.short, namedAddress({ formatted: "3328;3330 26th Street, San Francisco, CA", housenumber: "3328;3330",
    street: "26th Street", city: "San Francisco" })?.full], ["3328–3330 26th Street, San Francisco", "3328–3330 26th Street, San Francisco, CA"]);
  const { geoapify, urls } = client({ "/v1/geocode/reverse": reverse, "/v2/places": places });
  assert.equal((await geoapify.reverse(37.749, -122.4165))?.short, "3327 26th Street, San Francisco");
  // The nearest named one, not the first returned; an unnamed building, a bus stop or a bike-share
  // dock (November 10: one crowded a cafe out of the five kept) doesn't count.
  assert.deepEqual(await geoapify.nearbyPlace(37.749, -122.4165),
    { name: "Blue Bottle Coffee", category: "catering.cafe", category_label: "café", coordinate: { lat: 37.7491, lon: -122.4166 }, distance_m: 12 });
  const [reverseUrl, ...placesUrls] = urls.map(url => new URL(url));
  assert.deepEqual([reverseUrl.searchParams.get("lat"), reverseUrl.searchParams.get("format"), reverseUrl.searchParams.get("apiKey")],
    ["37.749", "json", "test-key"]);
  // Two Places requests, one per category group (Geoapify drops broad categories from a mixed list).
  assert.deepEqual(placesUrls.map(url => url.searchParams.get("categories")), PLACE_CATEGORY_GROUPS.map(group => group.join(",")));
  for (const url of placesUrls) assert.deepEqual([url.searchParams.get("filter"), url.searchParams.get("bias"), url.searchParams.get("conditions"),
    url.searchParams.get("limit")], ["circle:-122.4165,37.749,100", "proximity:-122.4165,37.749", "named", "20"]);
  // Merged by distance across groups, without duplicates: a hotel 8 m away beats the café at 12 m.
  const hotel = { properties: { name: "Hotel Nearby", place_id: "h1", categories: ["accommodation.hotel"], lat: 37.749, lon: -122.4165, distance: 8 } };
  const merged = client({ "/v2/places?catering": places, "/v2/places?tourism": { features: [hotel, hotel] } }).geoapify;
  assert.equal((await merged.nearbyPlace(37.749, -122.4165))?.name, "Hotel Nearby");
  // One group failing makes the answer unknown, not "nothing nearby".
  assert.equal(await client({ "/v2/places?catering": places }).geoapify.nearbyPlace(37.749, -122.4165), undefined);
  assert.equal(await client({ "/v2/places": { features: [] } }).geoapify.nearbyPlace(37.749, -122.4165), null);
});

test("Geoapify search returns addresses and businesses; failures and missing keys are explicit", async () => {
  const { geoapify, urls } = client({ "/v1/geocode/autocomplete": autocomplete });
  const results = await geoapify.search("blue bottle", { lat: 37.78, lon: -122.41 });
  assert.deepEqual(results.map(result => [result.name, result.address]), [
    ["Blue Bottle Coffee", "Blue Bottle Coffee, 66 Mint Street, San Francisco, CA 94103, United States of America"],
    // A street result's `name` is the street, not a place name.
    [null, "3327 26th Street, San Francisco, CA 94110, United States of America"]]);
  assert.equal(new URL(urls[0]).searchParams.get("bias"), "proximity:-122.41,37.78");
  await assert.rejects(client({}).geoapify.search("x"), { code: "place_lookup_failed", statusCode: 503 });
  await assert.rejects(new Geoapify(null).search("x"), { code: "place_lookup_unavailable", statusCode: 503 });
  assert.equal(await new Geoapify(null).reverse(1, 2), null, "without a key, visits stay unnamed");
});

test("the daily credit budget stops calls once it's spent, and resets each UTC day", async () => {
  let now = new Date("2026-11-05T23:59:00Z");
  const credits = new DailyCredits(2, () => now);
  assert.deepEqual([credits.take(), credits.take(), credits.take()], [true, true, false]);
  now = new Date("2026-11-06T00:00:01Z");
  assert.equal(credits.take(), true);
  const { geoapify, urls } = client({ "/v1/geocode/reverse": reverse }, 1);
  assert.ok(await geoapify.reverse(1, 2));
  assert.equal(await geoapify.reverse(1, 2), null);
  assert.equal(urls.length, 1, "no call once the budget is spent");
});

test("Phase 12: up to 5 candidates within the visit's accuracy (100–200 m), with readable categories", async () => {
  assert.deepEqual([nearbyRadius(3), nearbyRadius(150), nearbyRadius(500)], [100, 150, 200]);
  const many = { features: Array.from({ length: 8 }, (_, i) => ({ properties: { name: `Place ${i}`, place_id: `p${i}`,
    categories: i % 2 ? ["commercial", "commercial.health_and_beauty"] : ["building", "catering.cafe"], lat: 37.749, lon: -122.4165,
    distance: 10 + i * 30 } })) };
  const { geoapify, urls } = client({ "/v2/places": many });
  const found = await geoapify.nearbyPlaces(37.749, -122.4165, 150);
  assert.deepEqual(found?.map(place => [place.name, place.distance_m, place.category_label]),
    [["Place 0", 10, "café"], ["Place 1", 40, "shop"], ["Place 2", 70, "café"], ["Place 3", 100, "shop"], ["Place 4", 130, "café"]],
    "nearest first, within 150 m, at most 5, labelled from the most specific category we know");
  assert.equal(new URL(urls[0]).searchParams.get("filter"), "circle:-122.4165,37.749,150");
  assert.deepEqual([categoryLabel(["sport", "sport.fitness"]), categoryLabel(["man_made.tower"]), categoryLabel([])], ["gym", "tower", null]);
});

test("Phase 13: the agent's nearby search groups its categories, filters by name, and keeps hours and cuisine", async () => {
  assert.deepEqual(["catering.restaurant", "commercial", "tourism.sights", "accommodation", "airport", "sport.stadium", "sport.fitness.gym"]
    .map(categoryGroup), [0, 0, 1, 1, 1, 1, 0]);
  assert.equal(mostSpecificCategory(["catering", "catering.restaurant", "catering.restaurant.mexican", "building.catering"]),
    "catering.restaurant.mexican", "the deepest kind, not a building or condition");
  const taqueria = { properties: { name: "Taquería El Farolito", place_id: "t1", categories: ["catering", "catering.restaurant",
    "catering.restaurant.mexican"], catering: { cuisine: "mexican" }, opening_hours: "Mo-Su 10:00-02:00", lat: 37.7526, lon: -122.4184, distance: 9 } };
  const tacos = { properties: { name: "Tacos Cancún", place_id: "t2", categories: ["catering.fast_food"], lat: 37.7527, lon: -122.4185, distance: 14 } };
  const hotel = { properties: { name: "Hotel Mission", place_id: "h1", categories: ["accommodation.hotel"], lat: 37.7526, lon: -122.4184, distance: 5 } };
  const far = { properties: { name: "Far Taco", place_id: "t3", categories: ["catering.restaurant"], lat: 37.76, lon: -122.42, distance: 400 } };

  // One group: one request, with the name filter.
  const one = client({ "/v2/places": { features: [tacos, taqueria, far, taqueria] } });
  const found = await one.geoapify.searchNearby({ lat: 37.7526, lon: -122.4184, radiusM: 30, categories: ["catering.restaurant", "catering.fast_food"], text: "taco" });
  assert.deepEqual(found?.map(place => [place.name, place.distance_m]), [["Taquería El Farolito", 9], ["Tacos Cancún", 14]],
    "nearest first, within the radius, without duplicates");
  assert.deepEqual([found?.[0].category, found?.[0].cuisine, found?.[0].opening_hours, found?.[0].place_id],
    ["catering.restaurant.mexican", "mexican", "Mo-Su 10:00-02:00", "t1"]);
  assert.equal(one.urls.length, 1);
  const url = new URL(one.urls[0]);
  assert.deepEqual([url.searchParams.get("categories"), url.searchParams.get("name"), url.searchParams.get("filter"), url.searchParams.get("conditions")],
    ["catering.restaurant,catering.fast_food", "taco", "circle:-122.4184,37.7526,30", "named"]);

  // Both groups: two requests, merged; none given: the default groups.
  const both = client({ "/v2/places?catering.restaurant": { features: [taqueria] }, "/v2/places?accommodation": { features: [hotel] } });
  assert.deepEqual((await both.geoapify.searchNearby({ lat: 37.7526, lon: -122.4184, radiusM: 30,
    categories: ["catering.restaurant", "accommodation"] }))?.map(place => place.name), ["Hotel Mission", "Taquería El Farolito"]);
  assert.deepEqual(both.urls.map(u => new URL(u).searchParams.get("categories")), ["catering.restaurant", "accommodation"]);
  const all = client({ "/v2/places": { features: [] } });
  assert.deepEqual(await all.geoapify.searchNearby({ lat: 1, lon: 2, radiusM: 50, limit: 3 }), []);
  assert.deepEqual(all.urls.map(u => new URL(u).searchParams.get("categories")), PLACE_CATEGORY_GROUPS.map(group => group.join(",")));
  assert.deepEqual((await client({ "/v2/places": { features: Array.from({ length: 15 }, (_, i) =>
    ({ properties: { ...tacos.properties, place_id: `p${i}`, distance: i } })) } }).geoapify.searchNearby({ lat: 1, lon: 2, radiusM: 50,
    categories: ["catering"] }))?.length, 10, "at most 10");
  assert.equal(await client({}).geoapify.searchNearby({ lat: 1, lon: 2, radiusM: 50 }), null, "a failure isn't 'nothing here'");
});

test("Phase 13: place details", async () => {
  const details = { features: [{ properties: { feature_type: "details", name: "Taquería El Farolito", place_id: "t1",
    formatted: "Taquería El Farolito, 2779 Mission Street, San Francisco, CA 94110, United States of America",
    categories: ["catering", "catering.restaurant", "catering.restaurant.mexican"], catering: { cuisine: "mexican" },
    opening_hours: "Mo-Su 10:00-02:00", website: "https://elfarolitoinc.com", contact: { phone: "+1 415-824-7877" },
    facilities: { takeaway: true, delivery: false }, timezone: { name: "America/Los_Angeles" }, lat: 37.7526, lon: -122.4184 } }] };
  const { geoapify, urls } = client({ "/v2/place-details": details });
  assert.deepEqual(await geoapify.placeDetails("t1"), { place_id: "t1", name: "Taquería El Farolito",
    address: "Taquería El Farolito, 2779 Mission Street, San Francisco, CA 94110, United States of America",
    coordinate: { lat: 37.7526, lon: -122.4184 }, categories: ["catering", "catering.restaurant", "catering.restaurant.mexican"],
    category: "catering.restaurant.mexican", category_label: "restaurant", cuisine: "mexican", opening_hours: "Mo-Su 10:00-02:00",
    website: "https://elfarolitoinc.com", phone: "+1 415-824-7877", brand: null, takeaway: true, delivery: false, time_zone: "America/Los_Angeles" });
  assert.deepEqual([new URL(urls[0]).searchParams.get("id"), new URL(urls[0]).searchParams.get("features")], ["t1", "details"]);
  assert.equal(await client({}).geoapify.placeDetails("t1"), null);
});
