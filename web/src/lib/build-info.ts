/**
 * Web build identity, baked at build time (vite.config.ts `define`), same
 * shape as the daemon's BUD_BUILD_DESCRIBE: `git describe --tags --long
 * --always --dirty` — e.g. "v0.1.13-2-g2a57857" or "v0.1.13-0-g1234abc-dirty",
 * or a bare short SHA in a checkout with no reachable tag.
 */

/**
 * Full describe string for this build ("unknown" outside a Vite build, e.g.
 * node-run unit tests).
 */
export function buildDescribe(): string {
  return typeof __BUD_WEB_BUILD__ !== 'undefined' ? __BUD_WEB_BUILD__ : 'unknown'
}

/**
 * Short display form: the release tag alone ("v0.1.13") when the describe
 * string starts with one; otherwise the full string (bare SHA / "unknown")
 * is already as short as it gets.
 */
export function shortBuildVersion(describe: string): string {
  const match = /^(v\d+\.\d+\.\d+)(?:-|$)/.exec(describe)
  return match ? match[1]! : describe
}
