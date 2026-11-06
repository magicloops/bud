/**
 * Replaces the phone's Apple-sourced visit names with Geoapify ones, then deletes what's left
 * (Phase 11): Apple's terms don't allow keeping Map Data. Each environment needs approval.
 *
 *   pnpm db:geoapify-visit-names             # dry run: counts and the credits a rename would use
 *   pnpm db:geoapify-visit-names --rename    # rename, newest first, within today's credits
 *   pnpm db:geoapify-visit-names --delete-apple   # delete Apple-sourced names still left
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { Geoapify } from "../personal-data/geoapify.js";

const rename = process.argv.includes("--rename"), deleteApple = process.argv.includes("--delete-apple");
const limit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.slice(8) ?? 1000);

/** Apple-sourced names with the coordinate of their visit, or of their fix. */
const appleNames = async (count: number) => (await db.execute<{ id: string; latitude: number; longitude: number }>(sql`
  select n.id, coalesce(v.latitude, o.latitude) as latitude, coalesce(v.longitude, o.longitude) as longitude
  from location_visit_name n
  left join location_visit v on v.created_by_user_id = n.created_by_user_id and v.visit_key = n.visit_key
  left join location_observation o on o.created_by_user_id = n.created_by_user_id and o.visit_key = n.visit_key and o.kind = 'fix'
  where n.source = 'apple' and coalesce(v.latitude, o.latitude) is not null
  order by n.named_at desc limit ${count}`)).rows;

try {
  const [counts] = (await db.execute<{ apple: number; placeable: number; geoapify: number }>(sql`
    select count(*) filter (where n.source = 'apple')::int as apple, count(*) filter (where n.source = 'geoapify')::int as geoapify,
      count(*) filter (where n.source = 'apple' and (v.id is not null or o.id is not null))::int as placeable
    from location_visit_name n
    left join location_visit v on v.created_by_user_id = n.created_by_user_id and v.visit_key = n.visit_key
    left join location_observation o on o.created_by_user_id = n.created_by_user_id and o.visit_key = n.visit_key and o.kind = 'fix'`)).rows;
  console.log(`Apple-sourced names: ${counts.apple} (${counts.placeable} with a visit or fix to rename); Geoapify names: ${counts.geoapify}.`);
  console.log(`A rename uses about ${counts.placeable * 3} credits (a reverse geocode and two nearby-place lookups each).`);
  if (rename) {
    const geoapify = new Geoapify();
    if (!geoapify.available) throw new Error("GEOAPIFY_API_KEY isn't set");
    let renamed = 0, failed = 0;
    for (const row of await appleNames(limit)) {
      const address = await geoapify.reverse(Number(row.latitude), Number(row.longitude));
      const place = await geoapify.nearbyPlace(Number(row.latitude), Number(row.longitude));
      if ((!address && !place) || place === undefined) { failed++; continue; }
      await db.execute(sql`update location_visit_name set address = ${address ? JSON.stringify(address) : null}::jsonb, place = ${place ? JSON.stringify(place) : null}::jsonb,
        source = 'geoapify', raw_event_id = null, named_at = clock_timestamp(), received_at = clock_timestamp() where id = ${row.id}`);
      renamed++;
    }
    console.log(`Renamed ${renamed}; ${failed} found nothing or hit the credit limit (run again tomorrow).`);
  }
  if (deleteApple) {
    const deleted = await db.execute(sql`delete from location_visit_name where source = 'apple'`);
    console.log(`Deleted ${deleted.rowCount ?? 0} Apple-sourced names.`);
  }
  if (!rename && !deleteApple) console.log("Dry run. Pass --rename and then --delete-apple (each needs approval).");
} finally { await pool.end(); }
