import type { PoolClient } from "pg";
import { isValidBudAccentColor, withFallbackAccentColors } from "../bud-accent.js";

/** OKLCH → linear sRGB → sRGB, with explicit channel clipping for out-of-gamut accents.
 * Matrices: https://bottosson.github.io/posts/oklab/ (inverse transform).
 * This deliberately does not implement CSS perceptual gamut mapping.
 */
export function browserColorSeed(color: string): string | undefined {
  if (!isValidBudAccentColor(color)) return undefined;
  const [L, C, H] = color.slice(6, -1).split(" ").map(Number);
  const a = C * Math.cos(H * Math.PI / 180);
  const b = C * Math.sin(H * Math.PI / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  return "#" + channels.map((channel) => {
    const x = Math.max(0, Math.min(1, channel));
    const encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

/** Called only after launch-capable admission has authorized this Bud/owner.
 * Resolve NULL accents using the same owner-scoped set as the Bud inventory API.
 */
export async function resolveBrowserColor(database: Pick<PoolClient, "query">, owner: string, bud: string) {
  const { rows } = await database.query<{ budId: string; accentColor: string | null; createdAt: Date }>(
    `select bud_id as "budId", accent_color as "accentColor", created_at as "createdAt"
     from bud where created_by_user_id=$1`, [owner],
  );
  const color = withFallbackAccentColors(rows).find(row => row.budId === bud)?.accentColor;
  return color ? browserColorSeed(color) : undefined;
}
