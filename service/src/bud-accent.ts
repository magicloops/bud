/**
 * Bud accent-color assignment.
 *
 * Every Bud gets one stable accent color from a small palette. The rule is
 * positional — the first Bud is pink, the second orange, … — but keyed on
 * **creation order** (`created_at`, `bud_id` tiebreak; both are
 * creation-ordered), never on the `/api/buds` list order, which follows
 * `last_seen_at` and moves with every heartbeat
 * (see debug/bud-accent-color-flips-between-chats.md).
 *
 * Colors are persisted on `bud.accent_color` at device claim; rows that are
 * still NULL (claimed before persistence, or dev enrollment) are resolved at
 * read time by `withFallbackAccentColors`. Persisted / user-chosen colors are
 * treated as taken, so a fallback never collides with a deliberate pick.
 *
 * The web client mirrors this (`web/src/lib/theme-colors.ts`) for mixed
 * service/web versions; the palette order and the first-free rule MUST stay
 * identical on both sides.
 */

export const BUD_ACCENT_PALETTE: readonly string[] = [
  "oklch(0.70 0.25 330)", // pink
  "oklch(0.65 0.24 50)", // orange
  "oklch(0.68 0.22 190)", // cyan
  "oklch(0.72 0.23 280)", // purple
  "oklch(0.66 0.21 140)", // green
];

/**
 * The next color to hand out given the colors already in use: the first
 * palette color (in palette order) with the fewest uses. Unknown / NULL
 * entries are ignored.
 */
export function pickNextAccentColor(takenColors: Iterable<string | null | undefined>): string {
  const counts = new Map<string, number>(BUD_ACCENT_PALETTE.map((color) => [color, 0]));
  for (const color of takenColors) {
    if (color && counts.has(color)) {
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }
  }
  let best = BUD_ACCENT_PALETTE[0]!;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of BUD_ACCENT_PALETTE) {
    const count = counts.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

type AccentRow = {
  budId: string;
  accentColor: string | null;
  createdAt: Date | string | null;
};

function creationOrder(a: AccentRow, b: AccentRow): number {
  const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (at !== bt) {
    return at - bt;
  }
  return a.budId < b.budId ? -1 : a.budId > b.budId ? 1 : 0;
}

/**
 * Resolve accent colors for one owner's Buds: rows with a persisted color keep
 * it; NULL rows are assigned in creation order, each taking the first palette
 * color not already used. Input order is preserved.
 */
export function withFallbackAccentColors<T extends AccentRow>(buds: readonly T[]): T[] {
  const taken: string[] = buds.map((bud) => bud.accentColor).filter((color): color is string => Boolean(color));
  const assigned = new Map<string, string>();
  for (const bud of [...buds].sort(creationOrder)) {
    if (bud.accentColor) {
      continue;
    }
    const color = pickNextAccentColor(taken);
    taken.push(color);
    assigned.set(bud.budId, color);
  }
  return buds.map((bud) => {
    const color = assigned.get(bud.budId);
    return color ? { ...bud, accentColor: color } : bud;
  });
}

/**
 * Claim-time assignment for a new Bud: the first free color after resolving
 * the owner's OTHER Buds (`otherBuds` must exclude the Bud itself), so the
 * persisted color matches what the list would have shown positionally.
 */
export function assignBudAccentColor(otherBuds: readonly AccentRow[]): string {
  return pickNextAccentColor(withFallbackAccentColors(otherBuds).map((bud) => bud.accentColor));
}

/**
 * User-chosen accents are OKLCH strings, `oklch(L C H)`, because the web
 * derives the muted/soft theme variants by scaling chroma — a hex value would
 * flatten the theme. Ranges keep black text legible on the tinted chips
 * (lightness) and stay within what displays can show (chroma). The palette
 * entries and the web's hue picker (fixed L/C, free hue) both satisfy this.
 */
export const BUD_ACCENT_LIGHTNESS_RANGE: readonly [number, number] = [0.55, 0.85];
export const BUD_ACCENT_CHROMA_RANGE: readonly [number, number] = [0, 0.35];

const OKLCH_RE = /^oklch\((\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\)$/;

export function isValidBudAccentColor(color: string): boolean {
  const match = OKLCH_RE.exec(color);
  if (!match) {
    return false;
  }
  const l = Number(match[1]);
  const c = Number(match[2]);
  const h = Number(match[3]);
  return (
    l >= BUD_ACCENT_LIGHTNESS_RANGE[0] &&
    l <= BUD_ACCENT_LIGHTNESS_RANGE[1] &&
    c >= BUD_ACCENT_CHROMA_RANGE[0] &&
    c <= BUD_ACCENT_CHROMA_RANGE[1] &&
    h >= 0 &&
    h < 360
  );
}
