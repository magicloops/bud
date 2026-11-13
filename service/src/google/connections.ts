import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { googleConnectionTable as connections } from "../db/schema.js";
import { googleConfig, GOOGLE_SERVICES, GoogleError, serviceGranted, serviceWriteGranted, type GoogleConfig, type GoogleService, type GoogleSelection, type GoogleServiceAccess } from "./config.js";
import { GoogleOAuth } from "./oauth.js";
import { decryptGoogleCredentials, encryptGoogleCredentials, hashGoogleSecret, readGoogleEncryptionKey, type GoogleCredentials } from "./credentials.js";
import { googleFetch, googleJson } from "./http.js";
import type { GoogleRequest } from "./tool-contracts.js";

type Connection = typeof connections.$inferSelect;
const aad = (row: Connection) => JSON.stringify([row.createdByUserId, row.id, row.oauthClientId]);
const scopeAccess = (scopes: string[], service: GoogleService): GoogleServiceAccess =>
  !serviceGranted(scopes, service) ? "none" : serviceWriteGranted(scopes, service) ? "read_write" : "read_only";
function effectiveAccess(scopes: string[], data: GoogleCredentials): Record<GoogleService, GoogleServiceAccess> {
  return Object.fromEntries(GOOGLE_SERVICES.map(service => {
    const granted = scopeAccess(scopes, service), selected = data.serviceAccess?.[service] ?? (data.serviceAccess ? "none" : granted);
    return [service, selected === "none" || granted === "none" ? "none"
      : selected === "read_write" && granted === "read_write" ? "read_write" : "read_only"];
  })) as Record<GoogleService, GoogleServiceAccess>;
}

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
      email: connections.accountEmail, scopes: connections.grantedScopes, encrypted: connections.encryptedCredentials, updatedAt: connections.updatedAt })
      .from(connections).where(eq(connections.createdByUserId, owner));
    return rows.map(row => {
      const data = row.encrypted ? decryptGoogleCredentials(row.encrypted, JSON.stringify([owner, row.id, row.clientId]), this.key()) : {};
      const access = effectiveAccess(row.scopes, data);
      return { connection_id: row.id, email: row.email,
        status: row.clientId !== this.config.clientId ? "reconnect_required" : row.status === "connecting"
          ? data.previousStatus ?? "connecting" : row.status,
        calendar_access: access.calendar !== "none", calendar_write_access: access.calendar === "read_write",
        gmail_access: access.gmail !== "none", gmail_write_access: access.gmail === "read_write",
        drive_access: access.drive !== "none", drive_write_access: access.drive === "read_write",
        access,
        updated_at: row.updatedAt.toISOString() };
    });
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
        // Materialize legacy scope-derived access before exchanging or refreshing tokens.
        // Once present, explicit "none" entries must survive Google's combined grants.
        data.serviceAccess ??= effectiveAccess(row.grantedScopes, data);
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

  async begin(owner: string, sessionId: string, returnThreadId?: string, selections: GoogleSelection[] = [{ service: "calendar", access: "read_write" }]) {
    if (!this.config.clientId || !this.config.clientSecret) throw new GoogleError("google_not_configured");
    if (!selections.length || new Set(selections.map(selection => selection.service)).size !== selections.length ||
      selections.some(selection => !GOOGLE_SERVICES.includes(selection.service) || !["read_only", "read_write"].includes(selection.access))) {
      throw new GoogleError("google_invalid_selection");
    }
    this.key();
    await this.database.insert(connections).values({ id: `google_${ulid()}`, oauthClientId: this.config.clientId,
      status: "disconnected", createdByUserId: owner }).onConflictDoNothing({ target: connections.createdByUserId });
    const [found] = await this.database.select({ id: connections.id }).from(connections).where(eq(connections.createdByUserId, owner));
    return this.locked(owner, found.id, async (row, data) => {
      if (row.oauthClientId !== this.config.clientId) {
        delete data.tokens; row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
        data.serviceAccess = effectiveAccess([], {});
        data.previousStatus = "reconnect_required";
      } else if (row.status !== "connecting") {
        data.previousStatus = row.status === "connected" ? "connected" : "reconnect_required";
      }
      delete data.verifier; delete data.returnThreadId;
      data.requestedSelections = selections;
      if (returnThreadId) data.returnThreadId = returnThreadId;
      row.oauthClientId = this.config.clientId; row.status = "connecting";
      const state = randomBytes(32).toString("base64url");
      row.oauthStateHash = hashGoogleSecret(state); row.oauthSessionHash = hashGoogleSecret(sessionId);
      row.oauthExpiresAt = new Date(Date.now() + 10 * 60_000);
      const auth = await this.oauth.authorize(state, selections, row.accountEmail ?? undefined); data.verifier = auth.verifier;
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
      this.clearFlow(row); row.status = data.previousStatus ?? "reconnect_required";
      const returnThreadId = data.returnThreadId, verifier = data.verifier;
      const selections = data.requestedSelections ?? [{ service: "calendar", access: "read_write" } as const];
      delete data.returnThreadId; delete data.verifier; delete data.requestedSelections; delete data.previousStatus;
      try {
        if (row.oauthClientId !== this.config.clientId) throw new GoogleError("google_client_changed");
        if (params.has("error") || !params.get("code")) throw new GoogleError("google_consent_canceled");
        if (!verifier) throw new GoogleError("google_missing_verifier");
        const grant = await this.oauth.exchange(params.get("code")!, verifier, signal);
        if (row.accountSubject && grant.subject !== row.accountSubject) throw new GoogleError("google_account_mismatch");
        // Keep a usable existing token if a partial response omits established capabilities.
        // Never union old scope labels onto a new token that did not actually receive them.
        const previousAccess = effectiveAccess(row.grantedScopes, data);
        const missingPrior = GOOGLE_SERVICES.find(service => {
          const selection = selections.find(candidate => candidate.service === service);
          const retained = previousAccess[service] === "read_write" && selection?.access === "read_only"
            ? "read_only" : previousAccess[service];
          return retained !== "none" && !serviceGranted(grant.scopes, service) ||
            retained === "read_write" && !serviceWriteGranted(grant.scopes, service);
        });
        if (missingPrior) throw new GoogleError(`google_${missingPrior}_permissions_required`);
        const accepted = selections.filter(selection => serviceGranted(grant.scopes, selection.service));
        if (!accepted.length) throw new GoogleError(`google_${selections[0].service}_permissions_required`);
        const refreshToken = grant.tokens.refresh_token ?? data.tokens?.refresh_token;
        if (!refreshToken) throw new GoogleError("google_offline_access_required");
        grant.tokens.refresh_token = refreshToken;
        data.tokens = grant.tokens;
        for (const selection of accepted) {
          data.serviceAccess![selection.service] = selection.access === "read_write" && serviceWriteGranted(grant.scopes, selection.service)
            ? "read_write" : "read_only";
        }
        row.accountSubject = grant.subject; row.accountEmail = grant.email; row.grantedScopes = grant.scopes;
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

  async revokeService(owner: string, id: string, service: GoogleService) {
    if (!GOOGLE_SERVICES.includes(service)) throw new GoogleError("google_invalid_selection");
    return this.locked(owner, id, async (row, data) => {
      data.serviceAccess![service] = "none";
      // Invalidating every pending flow prevents a late callback from restoring access.
      this.clearFlow(row);
      if (row.status === "connecting") row.status = data.previousStatus ?? "reconnect_required";
      delete data.verifier; delete data.returnThreadId; delete data.requestedSelections; delete data.previousStatus;
      if (GOOGLE_SERVICES.every(candidate => effectiveAccess(row.grantedScopes, data)[candidate] === "none")) {
        delete data.tokens;
        row.status = "disconnected"; row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
      }
    });
  }

  async call(owner: string, id: string, request: GoogleRequest, signal: AbortSignal,
    beforeDispatch: (phase: "preflight" | "dispatch") => Promise<void>, service: GoogleService = "calendar",
    authorization?: { access: "read" | "write" }) {
    return this.locked(owner, id, async (row, data, timeout) => {
      if (!["connected", "connecting"].includes(row.status) || row.status === "connecting" && data.previousStatus !== "connected" ||
        !data.tokens || row.oauthClientId !== this.config.clientId) {
        throw new GoogleError("google_reconnect_required");
      }
      // This boundary derives mutation status from the reviewed HTTP request itself.
      const writes = request.method !== "GET" && !(service === "calendar" && request.method === "POST" && request.path === "/freeBusy");
      if (authorization && authorization.access !== (writes ? "write" : "read")) throw new GoogleError("google_invalid_request");
      const assertAccess = () => {
        const access = effectiveAccess(row.grantedScopes, data)[service];
        if (access === "none") throw new GoogleError(`google_${service}_permissions_required`);
        if (writes && access !== "read_write") throw new GoogleError(`google_${service}_write_permissions_required`);
      };
      assertAccess();
      const callSignal = AbortSignal.any([signal, timeout]); callSignal.throwIfAborted();
      try {
        if (!data.tokens.access_token || !data.tokens.expiry_date || data.tokens.expiry_date <= Date.now() + 60_000) {
          data.tokens = await this.oauth.refresh(data.tokens, callSignal);
          if (data.tokens.scope) row.grantedScopes = data.tokens.scope.split(/\s+/).filter(Boolean);
          assertAccess();
        }
        const base = service === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me"
          : service === "drive" ? `https://www.googleapis.com/${request.upload ? "upload/" : ""}drive/v3`
          : "https://www.googleapis.com/calendar/v3";
        const url = new URL(`${base}${request.path}`);
        for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
        const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
        if (body && Buffer.byteLength(body) > 64 * 1024) throw new GoogleError("google_request_too_large");
        const guardedFetch: typeof fetch = async (input, init) => { assertAccess(); return this.baseFetch(input, init); };
        if (request.filePreflight) {
          if (service !== "drive") throw new GoogleError("google_invalid_request");
          assertAccess();
          await beforeDispatch("preflight"); callSignal.throwIfAborted();
          const file = await googleJson(googleFetch(guardedFetch, callSignal),
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(request.filePreflight.fileId)}?fields=id,version,mimeType&supportsAllDrives=true`, data.tokens.access_token!);
          if (file.version !== request.filePreflight.version) throw new GoogleError("google_file_changed");
          if (request.filePreflight.uploadedOnly && String(file.mimeType).startsWith("application/vnd.google-apps.")) {
            throw new GoogleError("google_native_content_update_unsupported");
          }
        }
        assertAccess();
        await beforeDispatch("dispatch"); callSignal.throwIfAborted();
        assertAccess();
        // Check again at the transport edge after request body preparation has awaited.
        return await googleJson(googleFetch(guardedFetch, callSignal), url.href, data.tokens.access_token!, {
          method: request.method, body, headers: { ...(request.etag ? { "If-Match": request.etag } : {}),
            ...(request.contentType ? { "Content-Type": request.contentType } : {}) },
        }, request.responseMode);
      } catch (error) {
        if (error instanceof GoogleError && error.code === "google_reconnect_required") {
          this.clearFlow(row); delete data.verifier; delete data.returnThreadId; delete data.requestedSelections;
          delete data.previousStatus;
          row.status = "reconnect_required";
        }
        throw error;
      }
    });
  }
}
export const googleConnections = new GoogleConnections();
