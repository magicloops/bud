/**
 * Reads uploaded device diagnostics (bud-mobile `LOGGING.md`, "From the service"). Read-only.
 *
 *   pnpm db:diagnostics --owner adam@magicloops.dev --summary [--since 12:00]
 *   pnpm db:diagnostics --owner <id or email> --since "2026-11-06 12:00" --until 14:40 [--area upload] [--level notice]
 *   pnpm db:diagnostics --owner <…> --errors [--context 8]
 *   pnpm db:diagnostics --owner <…> --batch 6F2A9C11-…    # the phone's entries for a batch, then what the service stored
 *
 * `--installation` picks a phone (default: the one that uploaded last). Times without a date are
 * today in the phone's time zone; `--since` defaults to 24 hours ago.
 */
import { db, pool } from "../db/client.js";
import { DiagnosticsReport, errors, summary, timeline, clock, day } from "../personal-data/diagnostics-report.js";
import { LEVELS } from "../personal-data/diagnostics.js";

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const flag = (name: string) => args.includes(`--${name}`);

try {
  const ownerArg = option("owner");
  if (!ownerArg) throw new Error("--owner <user id or email> is required");
  const report = new DiagnosticsReport(db);
  const owner = await report.owner(ownerArg);
  const installation = option("installation") ?? await report.latestInstallation(owner);
  if (!installation) throw new Error("No diagnostics uploaded for this owner yet");
  const timeZone = await report.timeZone(owner);
  const now = new Date();
  const batch = option("batch");
  const from = option("since") ? report.parseTime(option("since")!, timeZone, now) : batch ? undefined : new Date(now.getTime() - 86_400_000);
  const to = option("until") ? report.parseTime(option("until")!, timeZone, from ?? now) : undefined;
  const level = option("level");
  const minimumLevel = level ? LEVELS.indexOf(level as typeof LEVELS[number]) : undefined;
  if (minimumLevel !== undefined && minimumLevel < 0) throw new Error(`--level is one of ${LEVELS.join(", ")}`);
  const rows = await report.entries(owner, installation, { from, to, area: option("area"), minimumLevel, batch });
  const known = await report.launches(owner, installation, [...new Set(rows.map(row => row.launchId))]);
  console.log(`installation ${installation}, times in ${timeZone}${from ? `, from ${day(from, timeZone)} ${clock(from, timeZone).slice(0, 5)}` : ""}`
    + `${to ? ` to ${clock(to, timeZone).slice(0, 5)}` : ""}\n`);
  if (flag("summary")) console.log(summary(rows, known, timeZone));
  else if (flag("errors")) console.log(errors(rows, known, timeZone, Number(option("context") ?? 5)));
  else console.log(timeline(rows, known, timeZone));
  if (batch) {
    const stored = await report.serviceBatch(owner, batch);
    console.log(`\nservice: ${stored.length ? "" : "nothing stored for this batch"}`);
    for (const row of stored)
      console.log(`  ${row.eventType} ×${row.count}, received ${day(row.first, timeZone)} ${clock(row.first, timeZone).slice(0, 8)}`
        + (row.last.getTime() !== row.first.getTime() ? `–${clock(row.last, timeZone).slice(0, 8)}` : ""));
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally { await pool.end(); }
