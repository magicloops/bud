/**
 * Bud display-name resolution (dynamic install names).
 *
 * Daemons request a name (BUD_DEVICE_NAME, defaulting to the machine's
 * short hostname), and the service resolves it against the owning user's
 * other Buds: first claim of "host" keeps "host", the next machine with the
 * same hostname becomes "host-2", then "host-3", ...
 *
 * The stability rule matters because `hello` re-sends the RAW requested
 * name on every reconnect: a Bud already named "host-2" whose daemon still
 * says "host" must keep "host-2" (not flip back and re-dedupe upward). A
 * genuinely different requested name (the user edited BUD_DEVICE_NAME)
 * re-resolves fresh, so renames keep working.
 */

import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { budTable } from "./db/schema.js";

export const BUD_NAME_MAX_LENGTH = 120;

/**
 * Resolve the stored name for a connected Bud's hello: unowned Buds (dev
 * bypass enrollment) keep the requested name verbatim; owned Buds resolve
 * against the owner's other Buds with the reconnect stability rule.
 * Shared by the WebSocket and gRPC control gateways.
 */
export async function resolveConnectedBudName(
  budId: string,
  requested: string,
  ownerUserId: string | null,
  currentName: string | null,
): Promise<string> {
  if (!ownerUserId) {
    return requested;
  }
  const ownedBuds = await db
    .select({ budId: budTable.budId, name: budTable.name })
    .from(budTable)
    .where(eq(budTable.createdByUserId, ownerUserId));
  const takenNames = ownedBuds
    .filter((bud) => bud.budId !== budId)
    .map((bud) => bud.name);
  return pickBudName(requested, takenNames, currentName);
}

function isSuffixedVariant(name: string, base: string): boolean {
  if (!name.startsWith(`${base}-`)) {
    return false;
  }
  const suffix = name.slice(base.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/**
 * Pick the stored name for a Bud requesting `requested`, given the names of
 * the owner's OTHER Buds (`takenNames` must exclude the Bud itself) and the
 * Bud's current stored name (null for first claim).
 */
export function pickBudName(
  requested: string,
  takenNames: Iterable<string>,
  currentName?: string | null,
): string {
  const base = (requested.trim() || "bud").slice(0, BUD_NAME_MAX_LENGTH);
  const taken = new Set(takenNames);

  if (
    currentName &&
    !taken.has(currentName) &&
    (currentName === base || isSuffixedVariant(currentName, base))
  ) {
    return currentName;
  }

  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, BUD_NAME_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
