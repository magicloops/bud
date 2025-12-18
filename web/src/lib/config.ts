// Client-side configuration from environment variables

const toBool = (value: string | undefined): boolean =>
  ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())

/**
 * Client configuration loaded from Vite env vars.
 * These are baked in at build time.
 */
export const config = {
  /** Show system messages (context sync, etc.) in chat timeline */
  showSystemMessages: toBool(import.meta.env.VITE_SHOW_SYSTEM_MESSAGES),

  /** Enable TanStack Router devtools */
  routerDevtools: toBool(import.meta.env.VITE_ROUTER_DEVTOOLS),
}
