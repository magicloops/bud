import { config } from "../config.js";

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
] as const;
export const GOOGLE_SCOPES = ["openid", "email", "profile", ...CALENDAR_SCOPES];
export const GOOGLE_SERVICES = ["calendar"] as const;
export type GoogleService = typeof GOOGLE_SERVICES[number];
export type GoogleAccess = "read_only" | "read_write";
export type GoogleWritePolicy = "read_only" | "ask_before_write";
export type GoogleSelection = { service: GoogleService; access: GoogleAccess };
export const SERVICE_NAMES: Record<GoogleService, string> = { calendar: "Google Calendar" };
export const SERVICE_SCOPES: Record<GoogleService, readonly string[]> = {
  calendar: CALENDAR_SCOPES,
};
export const SERVICE_READ_SCOPES: Record<GoogleService, readonly string[]> = {
  calendar: CALENDAR_SCOPES.map(scope => scope.endsWith("/calendar.events") ? `${scope}.readonly` : scope),
};
export const serviceScopes = (service: GoogleService, access: GoogleAccess = "read_write") =>
  ["openid", "email", "profile", ...(access === "read_only" ? SERVICE_READ_SCOPES : SERVICE_SCOPES)[service]];
export function serviceWriteGranted(scopes: string[], service: GoogleService): boolean {
  if (service === "calendar") return scopes.includes("https://www.googleapis.com/auth/calendar") ||
    scopes.includes("https://www.googleapis.com/auth/calendar.events");
  return false;
}
export function serviceGranted(scopes: string[], service: GoogleService): boolean {
  if (service === "calendar") return calendarGranted(scopes);
  return false;
}
export function googleWritesEnabled(): boolean {
  return process.env.GOOGLE_WRITES_ENABLED === undefined || process.env.GOOGLE_WRITES_ENABLED === "true";
}

export class GoogleError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export class GoogleHttpError extends GoogleError {
  constructor(public readonly status: number, reason?: "service_disabled") {
    super(status === 403 && reason === "service_disabled" ? "google_api_disabled"
      : status === 401 ? "google_reconnect_required" : status === 403 ? "google_access_denied"
      : status === 404 ? "google_resource_not_found" : status === 412 ? "google_event_changed"
      : status === 429 ? "google_rate_limited" : "google_api_failed");
  }
}

export function googleConfig() {
  const redirect = new URL(process.env.GOOGLE_REDIRECT_URI || "/api/google/callback", config.appBaseUrl);
  if (redirect.username || redirect.password || redirect.hash || redirect.search ||
    (redirect.protocol !== "https:" && !(process.env.NODE_ENV !== "production" &&
      redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))) {
    throw new GoogleError("google_invalid_redirect_uri");
  }
  return { clientId: config.googleClientId ?? "", clientSecret: config.googleClientSecret ?? "", redirectUri: redirect.href };
}
export type GoogleConfig = ReturnType<typeof googleConfig>;
export function googleConfigured(): boolean {
  const cfg = googleConfig();
  return Boolean(cfg.clientId && cfg.clientSecret && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

export function calendarGranted(scopes: string[]): boolean {
  return scopes.includes("https://www.googleapis.com/auth/calendar") || scopes.includes("https://www.googleapis.com/auth/calendar.readonly") ||
    CALENDAR_SCOPES.every(scope => scopes.includes(scope) || scope.endsWith("/calendar.events") && scopes.includes(`${scope}.readonly`));
}
