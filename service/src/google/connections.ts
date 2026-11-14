import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { googleConnectionTable as connections } from "../db/schema.js";
import { googleConfig, validateGoogleRedirectUri, GOOGLE_SERVICES, GoogleError, GoogleHttpError, serviceGranted, serviceWriteGranted, type GoogleConfig, type GoogleService, type GoogleSelection, type GoogleServiceAccess } from "./config.js";
import { GoogleOAuth } from "./oauth.js";
import { decryptGoogleCredentials, encryptGoogleCredentials, hashGoogleSecret, readGoogleEncryptionKey, type GoogleCredentials } from "./credentials.js";
import { googleFetch, googleJson } from "./http.js";
import type { GoogleRequest } from "./tool-contracts.js";

type Connection = typeof connections.$inferSelect;
type Snapshot = { row: Connection; data: GoogleCredentials; key?: Buffer };
const OPERATION_MS = 45_000;
const RELEASE_GRACE_MS = 5_000;
const LEASE_MS = OPERATION_MS + RELEASE_GRACE_MS;
function checkDeadline(data: GoogleCredentials, signal: AbortSignal) {
  signal.throwIfAborted();
  if ((data.operationExpiresAt ?? 0) - RELEASE_GRACE_MS <= Date.now()) throw new GoogleError("google_operation_timed_out", true);
}
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
  private readonly active = new Map<string, number>();
  constructor(readonly config: GoogleConfig = googleConfig(), private readonly database: Database = db,
    private readonly key = readGoogleEncryptionKey, private readonly oauth = new GoogleOAuth(config),
    private readonly baseFetch: typeof fetch = fetch) {}

  async list(owner: string) {
    const rows = await this.database.select({ id: connections.id, status: connections.status, clientId: connections.oauthClientId,
      email: connections.accountEmail, scopes: connections.grantedScopes, encrypted: connections.encryptedCredentials, updatedAt: connections.updatedAt })
      .from(connections).where(eq(connections.createdByUserId, owner));
    return rows.map(row => {
      let data: GoogleCredentials = {}, recoveryRequired = false;
      try { if (row.encrypted) data = decryptGoogleCredentials(row.encrypted, JSON.stringify([owner, row.id, row.clientId]), this.key()); }
      catch (error) {
        if (!this.credentialUnavailable(error)) throw error;
        recoveryRequired = true;
      }
      const access = effectiveAccess(recoveryRequired ? [] : row.scopes, data);
      return { connection_id: row.id, email: row.email,
        status: recoveryRequired || row.clientId !== this.config.clientId ? "reconnect_required" : row.status === "connecting"
          ? data.previousStatus ?? "connecting" : row.status,
        calendar_access: access.calendar !== "none", calendar_write_access: access.calendar === "read_write",
        gmail_access: access.gmail !== "none", gmail_write_access: access.gmail === "read_write",
        drive_access: access.drive !== "none", drive_write_access: access.drive === "read_write",
        access, ...(recoveryRequired ? { recovery_required: true as const } : {}),
        updated_at: row.updatedAt.toISOString() };
    });
  }

  private clearFlow(row: Connection) { row.oauthStateHash = null; row.oauthSessionHash = null; row.oauthExpiresAt = null; }
  private credentialUnavailable(error: unknown) {
    return error instanceof GoogleError && ["google_credentials_unreadable", "google_encryption_key_required", "google_encryption_key_invalid"].includes(error.code);
  }
  private clearConnection(row: Connection) {
    this.clearFlow(row); row.status = "disconnected"; row.encryptedCredentials = null;
    row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
  }
  private snapshot(row: Connection, recoverUnreadable: boolean): Snapshot {
    let key: Buffer | undefined, data: GoogleCredentials = {};
    try {
      key = this.key();
      if (row.encryptedCredentials) data = decryptGoogleCredentials(row.encryptedCredentials, aad(row), key);
    } catch (error) {
      if (!this.credentialUnavailable(error)) throw error;
      if (!recoverUnreadable) throw new GoogleError("google_reconnect_required");
      this.clearConnection(row);
    }
    data.serviceAccess ??= effectiveAccess(row.grantedScopes, data);
    return { row, data, key };
  }

  private async save(target: Pick<Database, "update">, { row, data, key }: Snapshot, expectedEnvelope?: string) {
    const encrypted = row.status === "disconnected" ? null : encryptGoogleCredentials(data, aad(row), key ?? this.key());
    const saved = await target.update(connections).set({ status: row.status, oauthClientId: row.oauthClientId,
      accountSubject: row.accountSubject, accountEmail: row.accountEmail, grantedScopes: row.grantedScopes,
      encryptedCredentials: encrypted, oauthStateHash: row.oauthStateHash, oauthSessionHash: row.oauthSessionHash,
      oauthExpiresAt: row.oauthExpiresAt, updatedAt: new Date() }).where(and(eq(connections.id, row.id),
      eq(connections.createdByUserId, row.createdByUserId), expectedEnvelope === undefined ? undefined :
        eq(connections.encryptedCredentials, expectedEnvelope))).returning({ id: connections.id });
    if (!saved.length) throw new GoogleError("google_connection_changed");
    row.encryptedCredentials = encrypted;
  }

  // Only local credential edits run under the row lock. Contenders release their
  // PostgreSQL client while waiting for another replica's bounded provider operation.
  private async edit<T>(owner: string, id: string, change: (state: Snapshot) => T | Promise<T>,
    recoverUnreadable = false, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + LEASE_MS + 1000;
    for (;;) {
      signal?.throwIfAborted();
      const outcome = await this.database.transaction(async tx => {
        const [row] = await tx.select().from(connections)
          .where(and(eq(connections.id, id), eq(connections.createdByUserId, owner))).for("update", { noWait: true });
        if (!row) throw new GoogleError("google_not_found");
        const state = this.snapshot(row, recoverUnreadable);
        if ((state.data.operationExpiresAt ?? 0) > Date.now()) return { busy: true as const };
        delete state.data.operationExpiresAt;
        signal?.throwIfAborted();
        const result = await change(state);
        await this.save(tx, state);
        return { busy: false as const, result };
      }).catch((error: unknown) => {
        // Drizzle may wrap pg's lock_not_available. Release the client and poll
        // just like a live operation lease instead of waiting inside PostgreSQL.
        const cause = error instanceof Error && error.cause ? error.cause : error;
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "55P03") {
          return { busy: true as const };
        }
        throw error;
      });
      if (!outcome.busy) return outcome.result;
      if (Date.now() >= deadline) throw new GoogleError("google_busy", true);
      await delay(100, undefined, { signal });
    }
  }

  private async withLease<T>(owner: string, id: string, signal: AbortSignal | undefined,
    run: (state: Snapshot, signal: AbortSignal, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const count = this.active.get(owner) ?? 0;
    if (count >= 4) throw new GoogleError("google_busy", true);
    this.active.set(owner, count + 1);
    try {
      const state = await this.edit(owner, id, state => {
        if (state.row.status === "disconnected") throw new GoogleError("google_reconnect_required");
        state.data.operationExpiresAt = Date.now() + LEASE_MS;
        return state;
      }, false, signal);
      const timeout = AbortSignal.timeout(Math.max(0, state.data.operationExpiresAt! - Date.now() - RELEASE_GRACE_MS));
      const operation = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const save = () => this.save(this.database, state, state.row.encryptedCredentials!);
      try {
        return await run(state, operation, save);
      } finally {
        // AES-GCM creates a unique envelope per save. A stale replica can never
        // commit over a newer lease, grant or disconnect even if it resumes much later.
        delete state.data.operationExpiresAt;
        await save();
      }
    } finally {
      const remaining = (this.active.get(owner) ?? 1) - 1;
      if (remaining) this.active.set(owner, remaining); else this.active.delete(owner);
    }
  }

  async begin(owner: string, sessionId: string, returnThreadId?: string, selections: GoogleSelection[] = [{ service: "calendar", access: "read_write" }]) {
    if (!this.config.clientId || !this.config.clientSecret) throw new GoogleError("google_not_configured");
    validateGoogleRedirectUri(this.config);
    if (!selections.length || new Set(selections.map(selection => selection.service)).size !== selections.length ||
      selections.some(selection => !GOOGLE_SERVICES.includes(selection.service) || !["read_only", "read_write"].includes(selection.access))) {
      throw new GoogleError("google_invalid_selection");
    }
    this.key();
    await this.database.insert(connections).values({ id: `google_${ulid()}`, oauthClientId: this.config.clientId,
      status: "disconnected", createdByUserId: owner }).onConflictDoNothing({ target: connections.createdByUserId });
    const [found] = await this.database.select({ id: connections.id }).from(connections).where(eq(connections.createdByUserId, owner));
    return this.edit(owner, found.id, async ({ row, data }) => {
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
    }, true);
  }

  async finish(owner: string, sessionId: string, params: URLSearchParams) {
    const stateHash = hashGoogleSecret(params.get("state") ?? "");
    const [found] = await this.database.select({ id: connections.id }).from(connections)
      .where(and(eq(connections.createdByUserId, owner), eq(connections.oauthStateHash, stateHash)));
    if (!found) throw new GoogleError("google_invalid_oauth_state");
    return this.withLease(owner, found.id, undefined, async ({ row, data }, signal, save) => {
      signal.throwIfAborted();
      if (row.status !== "connecting" || row.oauthStateHash !== stateHash ||
        row.oauthSessionHash !== hashGoogleSecret(sessionId) || !row.oauthExpiresAt || row.oauthExpiresAt <= new Date()) {
        throw new GoogleError("google_invalid_oauth_state");
      }
      this.clearFlow(row); row.status = data.previousStatus ?? "reconnect_required";
      const returnThreadId = data.returnThreadId, verifier = data.verifier;
      const selections = data.requestedSelections ?? [{ service: "calendar", access: "read_write" } as const];
      delete data.returnThreadId; delete data.verifier; delete data.requestedSelections; delete data.previousStatus;
      await save(); // consume the session-bound state before the exchange leaves the service
      try {
        if (row.oauthClientId !== this.config.clientId) throw new GoogleError("google_client_changed");
        if (params.has("error") || !params.get("code")) throw new GoogleError("google_consent_canceled");
        if (!verifier) throw new GoogleError("google_missing_verifier");
        const grant = await this.oauth.exchange(params.get("code")!, verifier, signal);
        checkDeadline(data, signal);
        if (row.accountSubject && grant.subject !== row.accountSubject) throw new GoogleError("google_account_mismatch");
        // A valid new grant is authoritative even when Google revoked older service scopes.
        // Do not overwrite the previous credentials unless a selected service was accepted.
        const accepted = selections.filter(selection => serviceGranted(grant.scopes, selection.service));
        if (!accepted.length) throw new GoogleError(`google_${selections[0].service}_permissions_required`);
        const refreshToken = grant.tokens.refresh_token ?? data.tokens?.refresh_token;
        if (!refreshToken) throw new GoogleError("google_offline_access_required");
        grant.tokens.refresh_token = refreshToken;
        data.tokens = grant.tokens;
        data.serviceAccess = effectiveAccess(grant.scopes, data);
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
    return this.edit(owner, id, ({ row }) => this.clearConnection(row), true);
  }

  async revokeService(owner: string, id: string, service: GoogleService) {
    if (!GOOGLE_SERVICES.includes(service)) throw new GoogleError("google_invalid_selection");
    return this.edit(owner, id, ({ row, data }) => {
      data.serviceAccess![service] = "none";
      // Invalidating every pending flow prevents a late callback from restoring access.
      this.clearFlow(row);
      if (row.status === "connecting") row.status = data.previousStatus ?? "reconnect_required";
      delete data.verifier; delete data.returnThreadId; delete data.requestedSelections; delete data.previousStatus;
      if (GOOGLE_SERVICES.every(candidate => effectiveAccess(row.grantedScopes, data)[candidate] === "none")) {
        delete data.tokens;
        this.clearConnection(row);
      }
    }, true);
  }

  async call(owner: string, id: string, request: GoogleRequest, signal: AbortSignal,
    beforeDispatch: (phase: "preflight" | "dispatch") => Promise<void>, service: GoogleService = "calendar",
    authorization?: { access: "read" | "write"; onDispatchChange?: (dispatched: boolean) => void }) {
    return this.withLease(owner, id, signal, async ({ row, data }, callSignal, save) => {
      if (!["connected", "connecting"].includes(row.status) || row.status === "connecting" && data.previousStatus !== "connected" ||
        !data.tokens || row.oauthClientId !== this.config.clientId) throw new GoogleError("google_reconnect_required");
      const writes = request.method !== "GET" && !(service === "calendar" && request.method === "POST" && request.path === "/freeBusy");
      if (authorization && authorization.access !== (writes ? "write" : "read")) throw new GoogleError("google_invalid_request");
      const assertAccess = () => {
        const access = effectiveAccess(row.grantedScopes, data)[service];
        if (access === "none") throw new GoogleError(`google_${service}_permissions_required`);
        if (writes && access !== "read_write") throw new GoogleError(`google_${service}_write_permissions_required`);
      };
      const refresh = async () => {
        data.tokens = await this.oauth.refresh(data.tokens!, callSignal);
        if (data.tokens.scope) row.grantedScopes = data.tokens.scope.split(/\s+/).filter(Boolean);
        await save(); // retain rotated credentials even if the following API call fails
        assertAccess();
      };
      const base = service === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me"
        : service === "drive" ? `https://www.googleapis.com/${request.upload ? "upload/" : ""}drive/v3`
        : "https://www.googleapis.com/calendar/v3";
      const url = new URL(`${base}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      const transport = (phase: "preflight" | "dispatch") => googleFetch(async (input, init) => {
        await beforeDispatch(phase);
        // Recheck our lease after async invocation/ownership authorization and body preparation.
        const [owned] = await this.database.select({ id: connections.id }).from(connections).where(and(
          eq(connections.id, id), eq(connections.createdByUserId, owner), eq(connections.encryptedCredentials, row.encryptedCredentials!)));
        if (!owned) throw new GoogleError("google_connection_changed");
        checkDeadline(data, callSignal); init?.signal?.throwIfAborted();
        const mutating = writes && phase === "dispatch";
        if (mutating) authorization?.onDispatchChange?.(true);
        const response = await this.baseFetch(input, init);
        if (mutating && response.status === 401) authorization?.onDispatchChange?.(false);
        return response;
      }, callSignal);
      const send = async () => {
        let body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
        if (request.filePreflight) {
          if (service !== "drive") throw new GoogleError("google_invalid_request");
          const file = await googleJson(transport("preflight"),
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(request.filePreflight.fileId)}?fields=id,version,mimeType&supportsAllDrives=true`, data.tokens!.access_token!);
          if (file.version !== request.filePreflight.version) throw new GoogleError("google_file_changed");
          if (request.filePreflight.uploadedOnly && String(file.mimeType).startsWith("application/vnd.google-apps.")) {
            throw new GoogleError("google_native_content_update_unsupported");
          }
          if (request.bodyWithMimeType) {
            if (typeof file.mimeType !== "string") throw new GoogleError("google_invalid_file_mime_type");
            body = request.bodyWithMimeType(file.mimeType);
          }
        }
        const result = await googleJson(transport("dispatch"), url.href, data.tokens!.access_token!, {
          method: request.method, body, headers: { ...(request.etag ? { "If-Match": request.etag } : {}),
            ...(request.contentType ? { "Content-Type": request.contentType } : {}) },
        }, request.responseMode);
        checkDeadline(data, callSignal);
        return result;
      };
      assertAccess(); callSignal.throwIfAborted();
      try {
        if (!data.tokens.access_token || !data.tokens.expiry_date || data.tokens.expiry_date <= Date.now() + 60_000) await refresh();
        try { return await send(); }
        catch (error) {
          if (!(error instanceof GoogleHttpError) || error.status !== 401) throw error;
          // Google explicitly rejected the request. Recheck access and preconditions before a single new attempt.
          callSignal.throwIfAborted();
          await refresh();
          return await send();
        }
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
