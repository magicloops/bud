/**
 * Bud accent-color assignment.
 *
 * Every Bud gets one stable accent color from a small palette. Colors are
 * persisted on `bud.accent_color` at device claim so they survive any list
 * ordering and any client; for legacy rows that are still NULL, callers fall
 * back to `pickBudAccentColor(budId)`, which is a pure function of the id.
 *
 * The web client derives the same fallback for the same reason (see
 * `web/src/lib/theme-colors.ts`); the palette and hash MUST stay identical on
 * both sides so a server-assigned color and a client-derived one agree.
 */

export const BUD_ACCENT_PALETTE: readonly string[] = [
  "oklch(0.70 0.25 330)", // pink
  "oklch(0.65 0.24 50)", // orange
  "oklch(0.68 0.22 190)", // cyan
  "oklch(0.72 0.23 280)", // purple
  "oklch(0.66 0.21 140)", // green
];

/** 32-bit FNV-1a over UTF-16 code units. Small, dependency-free, stable. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Order-independent fallback: the palette color a Bud id hashes to. Used for
 * rows whose `accent_color` is NULL (claimed before colors were persisted).
 */
export function pickBudAccentColor(budId: string): string {
  return BUD_ACCENT_PALETTE[fnv1a32(budId) % BUD_ACCENT_PALETTE.length]!;
}

/**
 * Claim-time assignment: the least-used palette color among the owner's OTHER
 * Buds (`takenColors` must exclude the Bud itself; NULL/custom colors are
 * ignored), ties broken by walking forward from the id's hash slot so the
 * choice stays deterministic and spreads across the palette.
 */
export function assignBudAccentColor(
  budId: string,
  takenColors: Iterable<string | null | undefined>,
): string {
  const counts = new Map<string, number>(BUD_ACCENT_PALETTE.map((color) => [color, 0]));
  for (const color of takenColors) {
    if (color && counts.has(color)) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  const minCount = Math.min(...counts.values());
  const start = fnv1a32(budId) % BUD_ACCENT_PALETTE.length;
  for (let offset = 0; offset < BUD_ACCENT_PALETTE.length; offset += 1) {
    const color = BUD_ACCENT_PALETTE[(start + offset) % BUD_ACCENT_PALETTE.length]!;
    if (counts.get(color) === minCount) {
      return color;
    }
  }
  return pickBudAccentColor(budId);
}
