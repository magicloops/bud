/**
 * Build-time constant injected by Vite `define` (vite.config.ts): the repo's
 * `git describe --tags --long --always --dirty` at build time. Read it via
 * `@/lib/build-info`, never directly — node-run unit tests have no Vite.
 */
declare const __BUD_WEB_BUILD__: string
