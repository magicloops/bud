import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { googleConnectionTable as connections } from "../db/schema.js";
import { googleConfig, validateGoogleRedirectUri, GOOGLE_SERVICES, GoogleError, GoogleHttpError, serviceGranted, serviceWriteGranted, type GoogleConfig, type GoogleService, type GoogleSelection, type GoogleServiceAccess } from "./config.js";
import { GoogleOAuth } from "./oauth.js";
import { decryptGoogleCredentials, encryptGoogleCredentials, hashGoogleSecret, readGoogleEncryptionKey, type GoogleCredentials } from "./credentials.js";
import { googleFetch, googleJson } from "./http.js";
import type { GoogleRequest } from "./tool-contracts.js";

type Connection = typeof connections.$inferSelect;
/** `bump` marks a change of authorization: the save raises `grant_epoch`. */
type Snapshot = { row: Connection; data: GoogleCredentials; key?: Buffer; bump?: boolean;
  /** Set by an edit that changed nothing, to skip the write. */
  unchanged?: boolean };
/** The longest one call or OAuth exchange may take, network included. */
const OPERATION_MS = 45_000;
/** How long an edit retries a row another transaction holds. Edits are local, so this is only reached when the database is in trouble. */
const LOCK_WAIT_MS = 2_000;
/**
 * How long one instance may hold the right to refresh a connection's tokens. Longer than a
 * refresh can take (the token request is cut off at 20 s), so it only ever expires on an
 * instance that died.
 */
const REFRESH_LEASE_MS = 30_000;
const validFor = (tokens: GoogleCredentials["tokens"], ms: number) =>
  Boolean(tokens?.access_token && tokens.expiry_date && tokens.expiry_date > Date.now() + ms);
const usable = (tokens: GoogleCredentials["tokens"]) => validFor(tokens, 60_000);
/** Stops waiting when `signal` aborts. The awaited work carries on for whoever else shares it. */
function abandonable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
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
  /** One refresh per connection in this process; callers that need one share it. */
  private readonly refreshes = new Map<string, Promise<Snapshot>>();
  constructor(readonly config: GoogleConfig = googleConfig(), private readonly database: Database = db,
    private readonly key = readGoogleEncryptionKey, private readonly oauth = new GoogleOAuth(config),
    private readonly baseFetch: typeof fetch = fetch, private readonly operationMs = OPERATION_MS) {}

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
    this.clearFlow(row); row.status = "disconnected"; row.encryptedCredentials = null; row.refreshLeaseUntil = null;
    row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
  }
  private snapshot(row: Connection, recoverUnreadable: boolean): Snapshot {
    let key: Buffer | undefined, data: GoogleCredentials = {}, bump = false;
    try {
      key = this.key();
      if (row.encryptedCredentials) data = decryptGoogleCredentials(row.encryptedCredentials, aad(row), key);
    } catch (error) {
      if (!this.credentialUnavailable(error)) throw error;
      if (!recoverUnreadable) throw new GoogleError("google_reconnect_required");
      this.clearConnection(row); bump = true;
    }
    // Written by the operation lease this design replaced; dropped on the next save.
    delete (data as { operationExpiresAt?: number }).operationExpiresAt;
    data.serviceAccess ??= effectiveAccess(row.grantedScopes, data);
    return { row, data, key, bump };
  }

  private async save(target: Pick<Database, "update">, state: Snapshot) {
    const { row, data, key } = state;
    const encrypted = row.status === "disconnected" ? null : encryptGoogleCredentials(data, aad(row), key ?? this.key());
    const grantEpoch = row.grantEpoch + (state.bump ? 1 : 0);
    const saved = await target.update(connections).set({ status: row.status, oauthClientId: row.oauthClientId,
      accountSubject: row.accountSubject, accountEmail: row.accountEmail, grantedScopes: row.grantedScopes,
      encryptedCredentials: encrypted, oauthStateHash: row.oauthStateHash, oauthSessionHash: row.oauthSessionHash,
      oauthExpiresAt: row.oauthExpiresAt, grantEpoch, refreshLeaseUntil: row.refreshLeaseUntil, updatedAt: new Date() }).where(and(eq(connections.id, row.id),
      eq(connections.createdByUserId, row.createdByUserId))).returning({ id: connections.id });
    if (!saved.length) throw new GoogleError("google_connection_changed");
    row.encryptedCredentials = encrypted; row.grantEpoch = grantEpoch; state.bump = false;
  }

  /** The connection as stored, without a lock. Calls work from this and recheck `grant_epoch` before each request. */
  private async read(owner: string, id: string): Promise<Snapshot> {
    const [row] = await this.database.select().from(connections)
      .where(and(eq(connections.id, id), eq(connections.createdByUserId, owner)));
    if (!row) throw new GoogleError("google_not_found");
    return this.snapshot(row, false);
  }

  /**
   * Every write: read the current row under its lock, change it, save. `change` is local work
   * only, never a request to Google, so the lock is held for milliseconds. Work that needs
   * Google runs between edits, and the edit after it checks `grant_epoch` first
   * (plan/google-connection-concurrency.md).
   *
   * A row another transaction holds is retried without waiting inside PostgreSQL, so a stalled
   * lock never keeps a pool client.
   */
  private async edit<T>(owner: string, id: string, change: (state: Snapshot, now: Date) => T | Promise<T>,
    recoverUnreadable = false, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      signal?.throwIfAborted();
      const outcome = await this.database.transaction(async tx => {
        // The database's clock, so instances agree on when a refresh lease ends.
        const [found] = await tx.select({ row: connections, now: sql<Date>`now()` }).from(connections)
          .where(and(eq(connections.id, id), eq(connections.createdByUserId, owner))).for("update", { noWait: true });
        if (!found) throw new GoogleError("google_not_found");
        const state = this.snapshot(found.row, recoverUnreadable);
        const result = await change(state, new Date(found.now));
        if (!state.unchanged || state.bump) await this.save(tx, state);
        return { busy: false as const, result };
      }).catch((error: unknown) => {
        // Drizzle may wrap pg's lock_not_available.
        const cause = error instanceof Error && error.cause ? error.cause : error;
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "55P03") {
          return { busy: true as const };
        }
        throw error;
      });
      if (!outcome.busy) return outcome.result;
      if (Date.now() >= deadline) throw new GoogleError("google_busy", true);
      await delay(50, undefined, { signal });
    }
  }

  /** At most four calls per owner run together in this process. */
  private async admitted<T>(owner: string, run: () => Promise<T>): Promise<T> {
    const count = this.active.get(owner) ?? 0;
    if (count >= 4) throw new GoogleError("google_busy", true);
    this.active.set(owner, count + 1);
    try { return await run(); }
    finally {
      const remaining = (this.active.get(owner) ?? 1) - 1;
      if (remaining) this.active.set(owner, remaining); else this.active.delete(owner);
    }
  }

  /**
   * A usable access token for the connection, refreshing at most once however many calls ask.
   * `rejected` is a token Google just answered 401 to: it is not handed back.
   */
  private refreshShared(owner: string, id: string, rejected?: GoogleCredentials["tokens"]): Promise<Snapshot> {
    // Within this process, callers share one attempt.
    const running = this.refreshes.get(id);
    if (running) return running;
    const flight = this.refreshOnce(owner, id, rejected).finally(() => { this.refreshes.delete(id); });
    this.refreshes.set(id, flight);
    return flight;
  }

  /**
   * Across instances, one refresh at a time: the instance that sets `refresh_lease_until`
   * asks Google, the others wait for its tokens. Google may issue a replacement refresh token,
   * and two instances asking at once could each be handed a different one.
   */
  private async refreshOnce(owner: string, id: string, rejected?: GoogleCredentials["tokens"]): Promise<Snapshot> {
    const isRejected = (tokens: GoogleCredentials["tokens"]) => rejected !== undefined &&
      tokens?.access_token === rejected.access_token && tokens?.expiry_date === rejected.expiry_date;
    const deadline = Date.now() + this.operationMs;
    for (;;) {
      const claim = await this.edit(owner, id, (state, now) => {
        const tokens = state.data.tokens;
        if (!tokens) throw new GoogleError("google_reconnect_required");
        state.unchanged = true;
        // Another call, or another instance, already refreshed.
        if (usable(tokens) && !isRejected(tokens)) return { state, lease: null };
        if (state.row.refreshLeaseUntil && state.row.refreshLeaseUntil > now) {
          // Another instance is refreshing. A token with a little life left needs no waiting.
          return validFor(tokens, 5_000) && !isRejected(tokens) ? { state, lease: null } : null;
        }
        state.unchanged = false;
        state.row.refreshLeaseUntil = new Date(now.getTime() + REFRESH_LEASE_MS);
        return { state, lease: state.row.refreshLeaseUntil };
      });
      if (!claim) {
        if (Date.now() >= deadline) throw new GoogleError("google_busy", true);
        await delay(250);
        continue;
      }
      if (!claim.lease) return claim.state;
      const { lease } = claim, epoch = claim.state.row.grantEpoch;
      // Ours to give back, unless it already ended and another instance took it.
      const release = (current: Snapshot) => {
        const ours = current.row.refreshLeaseUntil?.getTime() === lease.getTime();
        if (ours) current.row.refreshLeaseUntil = null;
        current.unchanged = !ours;
        return ours;
      };
      let refreshed: NonNullable<GoogleCredentials["tokens"]>;
      try {
        // Not a caller's signal: the callers share this request.
        refreshed = await this.oauth.refresh(claim.state.data.tokens!, AbortSignal.timeout(Math.min(this.operationMs, REFRESH_LEASE_MS - 5_000)));
      } catch (error) {
        // A failure only speaks for the connection while this instance holds the lease. Stalled
        // past it, another instance may have refreshed since (and Google may have retired the
        // token this one sent): go round again and use what that instance saved.
        const held = await this.edit(owner, id, release).catch((unverified: unknown) => {
          // Whether the lease is still ours could not be read, so the failure can't be trusted
          // either way. Nothing is concluded about the grant; the caller may try again. (A lease
          // left set ends by itself.)
          throw unverified instanceof GoogleError && unverified.code === "google_not_found" ? unverified : new GoogleError("google_busy", true);
        });
        if (!held) continue;
        throw error;
      }
      const saved = await this.edit(owner, id, current => {
        const held = release(current);
        // The user disconnected, revoked or granted again meanwhile: these tokens belong to the old grant.
        if (current.row.grantEpoch !== epoch) return "changed" as const;
        // This instance stalled past its lease and another one refreshed. Nothing cuts off a
        // paused process, so the lease is checked here, under the row lock: the later tokens stay.
        if (!held) return "superseded" as const;
        current.data.tokens = refreshed; // a replacement refresh token is saved here, before anyone uses the access token
        if (refreshed.scope) current.row.grantedScopes = refreshed.scope.split(/\s+/).filter(Boolean);
        return current;
      });
      if (saved === "changed") throw new GoogleError("google_connection_changed", true);
      // Go round again: the other instance's tokens are there to use, or about to be.
      if (saved === "superseded") continue;
      return saved;
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
    return this.edit(owner, found.id, async snapshot => {
      const { row, data } = snapshot;
      if (row.oauthClientId !== this.config.clientId) {
        delete data.tokens; row.accountSubject = null; row.accountEmail = null; row.grantedScopes = [];
        data.serviceAccess = effectiveAccess([], {});
        data.previousStatus = "reconnect_required";
        snapshot.bump = true;
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
    // Consume the session-bound state before the exchange leaves the service.
    const flow = await this.edit(owner, found.id, ({ row, data }) => {
      if (row.status !== "connecting" || row.oauthStateHash !== stateHash ||
        row.oauthSessionHash !== hashGoogleSecret(sessionId) || !row.oauthExpiresAt || row.oauthExpiresAt <= new Date()) {
        throw new GoogleError("google_invalid_oauth_state");
      }
      this.clearFlow(row); row.status = data.previousStatus ?? "reconnect_required";
      const taken = { returnThreadId: data.returnThreadId, verifier: data.verifier, clientId: row.oauthClientId, epoch: row.grantEpoch,
        selections: data.requestedSelections ?? [{ service: "calendar", access: "read_write" } as const] };
      delete data.returnThreadId; delete data.verifier; delete data.requestedSelections; delete data.previousStatus;
      return taken;
    });
    const timeout = AbortSignal.timeout(this.operationMs);
    try {
      if (flow.clientId !== this.config.clientId) throw new GoogleError("google_client_changed");
      if (params.has("error") || !params.get("code")) throw new GoogleError("google_consent_canceled");
      if (!flow.verifier) throw new GoogleError("google_missing_verifier");
      const grant = await this.oauth.exchange(params.get("code")!, flow.verifier, timeout);
      return await this.edit(owner, found.id, state => {
        const { row, data } = state;
        // The user disconnected or revoked while Google was answering: the grant is not applied.
        if (row.grantEpoch !== flow.epoch) throw new GoogleError("google_connection_changed");
        if (row.accountSubject && grant.subject !== row.accountSubject) throw new GoogleError("google_account_mismatch");
        // A valid new grant is authoritative even when Google revoked older service scopes.
        // Do not overwrite the previous credentials unless a selected service was accepted.
        const accepted = flow.selections.filter(selection => serviceGranted(grant.scopes, selection.service));
        if (!accepted.length) throw new GoogleError(`google_${flow.selections[0].service}_permissions_required`);
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
        // A newer connect flow started meanwhile stays pending (the flow check forbids
        // `connected` with flow fields set); this grant is what it falls back to.
        if (row.status === "connecting") data.previousStatus = "connected"; else row.status = "connected";
        state.bump = true;
        return flow.returnThreadId;
      });
    } catch (error) {
      const code = error instanceof GoogleError ? error.code : "google_connection_failed";
      // The exchange reports an aborted request as a failed authorization.
      throw new GoogleCallbackError(timeout.aborted && code === "google_authorization_failed" ? "google_operation_timed_out" : code,
        flow.returnThreadId);
    }
  }

  async disconnect(owner: string, id: string) {
    return this.edit(owner, id, state => { this.clearConnection(state.row); state.bump = true; }, true);
  }

  async revokeService(owner: string, id: string, service: GoogleService) {
    if (!GOOGLE_SERVICES.includes(service)) throw new GoogleError("google_invalid_selection");
    return this.edit(owner, id, state => {
      const { row, data } = state;
      data.serviceAccess![service] = "none";
      state.bump = true;
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
    return this.admitted(owner, async () => {
      const timeout = AbortSignal.timeout(this.operationMs), callSignal = AbortSignal.any([signal, timeout]);
      const writes = request.method !== "GET" && !(service === "calendar" && request.method === "POST" && request.path === "/freeBusy");
      const assertUsable = ({ row, data }: Snapshot) => {
        if (!["connected", "connecting"].includes(row.status) || row.status === "connecting" && data.previousStatus !== "connected" ||
          !data.tokens || row.oauthClientId !== this.config.clientId) throw new GoogleError("google_reconnect_required");
      };
      const assertAccess = ({ row, data }: Snapshot) => {
        const access = effectiveAccess(row.grantedScopes, data)[service];
        if (access === "none") throw new GoogleError(`google_${service}_permissions_required`);
        if (writes && access !== "read_write") throw new GoogleError(`google_${service}_write_permissions_required`);
      };
      let state = await this.read(owner, id);
      assertUsable(state);
      if (authorization && authorization.access !== (writes ? "write" : "read")) throw new GoogleError("google_invalid_request");
      // The grant this call was started under. A disconnect, revoke or new grant raises the epoch.
      const epoch = state.row.grantEpoch;
      const sameGrant = (latest: Snapshot) => {
        if (latest.row.grantEpoch === epoch) return;
        // Say what is missing when access is gone. Otherwise stop anyway: the account may be a
        // different one, and this request was prepared for the old grant.
        assertUsable(latest); assertAccess(latest);
        throw new GoogleError("google_connection_changed", true);
      };
      const refresh = async (rejected?: GoogleCredentials["tokens"]) => {
        // A cancelled or timed-out call stops waiting; the refresh carries on for the others.
        const latest = await abandonable(this.refreshShared(owner, id, rejected), callSignal);
        sameGrant(latest);
        state = latest;
        assertAccess(state);
      };
      const base = service === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me"
        : service === "drive" ? `https://www.googleapis.com/${request.upload ? "upload/" : ""}drive/v3`
        : "https://www.googleapis.com/calendar/v3";
      const url = new URL(`${base}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      const transport = (phase: "preflight" | "dispatch") => googleFetch(async (input, init) => {
        await beforeDispatch(phase);
        // After the async invocation and ownership checks: is this still the grant the call started under?
        const [current] = await this.database.select({ epoch: connections.grantEpoch }).from(connections)
          .where(and(eq(connections.id, id), eq(connections.createdByUserId, owner)));
        if (!current) throw new GoogleError("google_connection_changed");
        if (current.epoch !== epoch) sameGrant(await this.read(owner, id));
        callSignal.throwIfAborted(); init?.signal?.throwIfAborted();
        const mutating = writes && phase === "dispatch";
        if (mutating) authorization?.onDispatchChange?.(true);
        const response = await this.baseFetch(input, init);
        if (mutating && response.status === 401) authorization?.onDispatchChange?.(false);
        return response;
      }, callSignal);
      const send = async () => {
        const token = state.data.tokens!.access_token!;
        let body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
        if (request.filePreflight) {
          if (service !== "drive") throw new GoogleError("google_invalid_request");
          const file = await googleJson(transport("preflight"),
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(request.filePreflight.fileId)}?fields=id,version,mimeType&supportsAllDrives=true`, token);
          if (file.version !== request.filePreflight.version) throw new GoogleError("google_file_changed");
          if (request.filePreflight.uploadedOnly && String(file.mimeType).startsWith("application/vnd.google-apps.")) {
            throw new GoogleError("google_native_content_update_unsupported");
          }
          if (request.bodyWithMimeType) {
            if (typeof file.mimeType !== "string") throw new GoogleError("google_invalid_file_mime_type");
            body = request.bodyWithMimeType(file.mimeType);
          }
        }
        return googleJson(transport("dispatch"), url.href, token, {
          method: request.method, body, headers: { ...(request.etag ? { "If-Match": request.etag } : {}),
            ...(request.contentType ? { "Content-Type": request.contentType } : {}) },
        }, request.responseMode);
      };
      assertAccess(state); callSignal.throwIfAborted();
      try {
        if (!usable(state.data.tokens)) await refresh();
        try { return await send(); }
        catch (error) {
          if (!(error instanceof GoogleHttpError) || error.status !== 401) throw error;
          // Google explicitly rejected the request. Recheck access and preconditions before a single new attempt.
          callSignal.throwIfAborted();
          await refresh(state.data.tokens);
          return await send();
        }
      } catch (error) {
        if (error instanceof GoogleError && error.code === "google_reconnect_required") {
          // Best effort: if this can't be recorded, the next call finds out the same way.
          await this.edit(owner, id, current => {
            if (current.row.grantEpoch !== epoch) return;
            this.clearFlow(current.row); delete current.data.verifier; delete current.data.returnThreadId;
            delete current.data.requestedSelections; delete current.data.previousStatus;
            current.row.status = "reconnect_required"; current.bump = true;
          }).catch(() => {});
        }
        // Nothing here answers for a request the deadline cut off. A write that was already
        // sent is still reported as unknown by the executor.
        if (timeout.aborted && !signal.aborted && !(error instanceof GoogleError)) throw new GoogleError("google_operation_timed_out", true);
        throw error;
      }
    });
  }
}
export const googleConnections = new GoogleConnections();
