import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { googleConnectionTable as connections } from "../db/schema.js";
import { calendarGranted, googleConfig, GoogleError, type GoogleConfig } from "./config.js";
import { GoogleOAuth } from "./oauth.js";
import { decryptGoogleCredentials, encryptGoogleCredentials, hashGoogleSecret, readGoogleEncryptionKey, type GoogleCredentials } from "./credentials.js";
import { googleFetch, googleJson } from "./http.js";
import type { CalendarRequest } from "./calendar.js";

type Connection = typeof connections.$inferSelect;
const aad = (row: Connection) => JSON.stringify([row.createdByUserId, row.id, row.oauthClientId]);
// Return context is exposed only after validating the owner/session-bound state.
export class GoogleCallbackError extends GoogleError {
  constructor(code: string, readonly returnThreadId?: string) { super(code); }
}
export class GoogleConnections {
  private active = 0;
  constructor(readonly config: GoogleConfig = googleConfig(), private readonly database: Database = db,
    private readonly key = readGoogleEncryptionKey, private readonly oauth = new GoogleOAuth(config),
    private readonly baseFetch: typeof fetch = fetch) {}

  async list(owner: string) {
    const rows = await this.database.select({ id: connections.id, status: connections.status, clientId: connections.oauthClientId,
      email: connections.accountEmail, scopes: connections.grantedScopes, updatedAt: connections.updatedAt })
      .from(connections).where(eq(connections.createdByUserId, owner));
    return rows.map(row => ({ connection_id: row.id, email: row.email,
      status: row.clientId === this.config.clientId ? row.status : "reconnect_required",
      calendar_access: calendarGranted(row.scopes), updated_at: row.updatedAt.toISOString() }));
  }

  private clearFlow(row: Connection) { row.oauthStateHash = null; row.oauthSessionHash = null; row.oauthExpiresAt = null; }
  private async locked<T>(owner: string, id: string,
    fn: (row: Connection, data: GoogleCredentials, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active >= 4) throw new GoogleError("google_busy");
    this.active++;
    try {
      const outcome = await this.database.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        const [row] = await tx.select().from(connections)
          .where(and(eq(connections.id, id), eq(connections.createdByUserId, owner))).for("update");
        if (!row) throw new GoogleError("google_not_found");
        const key = this.key(), data = row.encryptedCredentials ? decryptGoogleCredentials(row.encryptedCredentials, aad(row), key) : {};
        let result: T | undefined, error: unknown;
        try { result = await fn(row, data, AbortSignal.timeout(45_000)); } catch (caught) { error = caught; }
        // Persist consumed state and rotated tokens even if a later API call fails.
        await tx.update(connections).set({ status: row.status, oauthClientId: row.oauthClientId,
          accountSubject: row.accountSubject, accountEmail: row.accountEmail, grantedScopes: row.grantedScopes,
          encryptedCredentials: row.status === "disconnected" ? null : encryptGoogleCredentials(data, aad(row), key),
          oauthStateHash: row.oauthStateHash, oauthSessionHash: row.oauthSessionHash, oauthExpiresAt: row.oauthExpiresAt,
          updatedAt: new Date() }).where(and(eq(connections.id, id), eq(connections.createdByUserId, owner)));
        return { result, error };
      });
      if (outcome.error) throw outcome.error;
      return outcome.result as T;
    } finally { this.active--; }
  }

  async begin(owner: string, sessionId: string, returnThreadId?: string) {
    if (!this.config.clientId || !this.config.clientSecret) throw new GoogleError("google_not_configured");
    this.key();
    await this.database.insert(connections).values({ id: `google_${ulid()}`, oauthClientId: this.config.clientId,
      status: "disconnected", createdByUserId: owner }).onConflictDoNothing({ target: connections.createdByUserId });
    const [found] = await this.database.select({ id: connections.id }).from(connections).where(eq(connections.createdByUserId, owner));
    return this.locked(owner, found.id, async (row, data) => {
      delete data.tokens; delete data.verifier; delete data.returnThreadId;
      if (returnThreadId) data.returnThreadId = returnThreadId;
      row.oauthClientId = this.config.clientId; row.status = "connecting";
      row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
      const state = randomBytes(32).toString("base64url");
      row.oauthStateHash = hashGoogleSecret(state); row.oauthSessionHash = hashGoogleSecret(sessionId);
      row.oauthExpiresAt = new Date(Date.now() + 10 * 60_000);
      const auth = await this.oauth.authorize(state); data.verifier = auth.verifier;
      return auth.url;
    });
  }

  async finish(owner: string, sessionId: string, params: URLSearchParams) {
    const stateHash = hashGoogleSecret(params.get("state") ?? "");
    const [found] = await this.database.select({ id: connections.id }).from(connections)
      .where(and(eq(connections.createdByUserId, owner), eq(connections.oauthStateHash, stateHash)));
    if (!found) throw new GoogleError("google_invalid_oauth_state");
    return this.locked(owner, found.id, async (row, data, signal) => {
      if (row.status !== "connecting" || row.oauthStateHash !== stateHash ||
        row.oauthSessionHash !== hashGoogleSecret(sessionId) || !row.oauthExpiresAt || row.oauthExpiresAt <= new Date()) {
        throw new GoogleError("google_invalid_oauth_state");
      }
      this.clearFlow(row); row.status = "reconnect_required";
      const returnThreadId = data.returnThreadId, verifier = data.verifier;
      delete data.returnThreadId; delete data.verifier;
      try {
        if (row.oauthClientId !== this.config.clientId) throw new GoogleError("google_client_changed");
        if (params.has("error") || !params.get("code")) throw new GoogleError("google_consent_canceled");
        if (!verifier) throw new GoogleError("google_missing_verifier");
        const grant = await this.oauth.exchange(params.get("code")!, verifier, signal);
        data.tokens = grant.tokens;
        row.accountSubject = grant.subject; row.accountEmail = grant.email; row.grantedScopes = grant.scopes;
        if (!calendarGranted(grant.scopes)) throw new GoogleError("google_calendar_permissions_required");
        row.status = "connected";
        return returnThreadId;
      } catch (error) {
        throw new GoogleCallbackError(error instanceof GoogleError ? error.code : "google_connection_failed", returnThreadId);
      }
    });
  }

  async disconnect(owner: string, id: string) {
    const rows = await this.database.update(connections).set({ status: "disconnected", encryptedCredentials: null,
      accountSubject: null, accountEmail: null, grantedScopes: [], oauthStateHash: null, oauthSessionHash: null,
      oauthExpiresAt: null, updatedAt: new Date() }).where(and(eq(connections.id, id), eq(connections.createdByUserId, owner))).returning({ id: connections.id });
    if (!rows.length) throw new GoogleError("google_not_found");
  }

  async call(owner: string, id: string, request: CalendarRequest, signal: AbortSignal, beforeDispatch: () => Promise<void>) {
    return this.locked(owner, id, async (row, data, timeout) => {
      if (row.status !== "connected" || !data.tokens || row.oauthClientId !== this.config.clientId || !calendarGranted(row.grantedScopes)) {
        throw new GoogleError("google_reconnect_required");
      }
      const callSignal = AbortSignal.any([signal, timeout]); callSignal.throwIfAborted();
      try {
        if (!data.tokens.access_token || !data.tokens.expiry_date || data.tokens.expiry_date <= Date.now() + 60_000) {
          data.tokens = await this.oauth.refresh(data.tokens, callSignal);
          if (data.tokens.scope) row.grantedScopes = data.tokens.scope.split(/\s+/).filter(Boolean);
          if (!calendarGranted(row.grantedScopes)) throw new GoogleError("google_reconnect_required");
        }
        const url = new URL(`https://www.googleapis.com/calendar/v3${request.path}`);
        for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
        const body = request.body === undefined ? undefined : JSON.stringify(request.body);
        if (body && Buffer.byteLength(body) > 64 * 1024) throw new GoogleError("google_request_too_large");
        await beforeDispatch(); callSignal.throwIfAborted();
        return await googleJson(googleFetch(this.baseFetch, callSignal), url.href, data.tokens.access_token!, {
          method: request.method, body, headers: request.etag ? { "If-Match": request.etag } : undefined,
        });
      } catch (error) {
        if (error instanceof GoogleError && error.code === "google_reconnect_required") row.status = "reconnect_required";
        throw error;
      }
    });
  }
}
export const googleConnections = new GoogleConnections();
