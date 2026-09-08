import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { db, type Database } from "../db/client.js";
import { dataAccessRequestTable as requests, dataAppKeyTable as keys, dataOwnerStateTable as owners,
  agentInvocationTable as invocations, agentInvocationActionTable as actions,
  threadTable as threads, budTable as buds, proxiedSiteTable as sites } from "../db/schema.js";
import { APP_KEY_LIMITS, appKeyDecisionSchema, appKeyRequestSchema, appKeyRevokeSchema, appKeyProofSchema,
  parseAppKeyInput, type AppKeyRequestDefinition, type AppDataPolicy } from "./app-key-contracts.js";
import { createAppQueryCredential, sealAppQueryCredential, verifyAppKeyProof, verifyAppQueryCredential,
  type AppKeyContext, type AppKeyEnvelope } from "./app-key-crypto.js";
import { canonicalJson, DataRequestError } from "./contracts.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Request = typeof requests.$inferSelect;
type Key = typeof keys.$inferSelect;
export type AppKeyAuthority = { owner: string; keyId: string; version: number; policy: AppDataPolicy };
export type AppKeyRequestContext = { owner: string; invocationId: string; workerId: string; fence: number; callId: string };
export const APP_KEY_REQUEST_TOOL = "data_request_api_key";
const notFound = () => new DataRequestError(404, "app_data_not_found", "App data permission not found");
const conflict = () => new DataRequestError(409, "app_data_conflict", "App data permission changed; reload before continuing");
const denied = () => new DataRequestError(403, "app_data_key_invalid", "App data key is unavailable");
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

function definition(row: Request): AppKeyRequestDefinition {
  const value = row.definition as unknown as AppKeyRequestDefinition;
  return parseAppKeyInput(appKeyRequestSchema, { ...value, destination: {
    proxied_site_id: value.destination?.proxied_site_id, public_key: value.destination?.public_key?.public_key,
  } });
}

/** Ordinary serializers explicitly select public metadata, never key/envelope/proof fields. */
export function serializeAppKey(row: Key) {
  return { key_id: row.id, request_id: row.requestId, status: row.status, version: row.version,
    setup_expires_at: row.setupExpiresAt, installed_at: row.installedAt, revoked_at: row.revokedAt,
    outcome_code: row.outcomeCode, last_used_at: row.lastUsedAt, created_at: row.createdAt, updated_at: row.updatedAt };
}
export function serializeAppDataRequest(row: Request) {
  const value = definition(row);
  return { request_id: row.id, invocation_id: row.invocationId, thread_id: row.threadId, bud_id: row.budId,
    call_id: row.callId, app_label: value.app_label, purpose: value.purpose, data_access: value.data_access,
    destination: { proxied_site_id: row.proxiedSiteId, recipient_fingerprint: value.destination.public_key.fingerprint },
    status: row.status, version: row.version, expires_at: row.expiresAt,
    decided_at: row.decidedAt, created_at: row.createdAt, updated_at: row.updatedAt };
}

export class AppKeys {
  constructor(private readonly database: Database = db, private readonly now = () => new Date()) {}

  private async lockOwner(tx: Transaction, owner: string) {
    await tx.insert(owners).values({ createdByUserId: owner }).onConflictDoNothing();
    await tx.select().from(owners).where(eq(owners.createdByUserId, owner)).for("update");
  }
  private async load(tx: Transaction, owner: string, id: string) {
    const [row] = await tx.select().from(requests).where(and(eq(requests.id, id), eq(requests.createdByUserId, owner)));
    if (!row) throw notFound();
    return row;
  }
  private async validSite(tx: Transaction | Database, owner: string, siteId: string, budId: string) {
    const [site] = await tx.select({ id: sites.proxiedSiteId }).from(sites)
      .innerJoin(buds, and(eq(buds.budId, sites.budId), eq(buds.createdByUserId, owner)))
      .where(and(eq(sites.proxiedSiteId, siteId), eq(sites.budId, budId), eq(sites.createdByUserId, owner),
        eq(sites.enabled, true), eq(sites.accessPolicy, "private_owner"), gt(sites.expiresAt, this.now())));
    return !!site;
  }
  private async activeInvocation(tx: Transaction, owner: string, id: string) {
    const [row] = await tx.select({ invocation: invocations }).from(invocations)
      .innerJoin(threads, and(eq(threads.threadId, invocations.threadId), eq(threads.createdByUserId, owner), isNull(threads.deletedAt)))
      .innerJoin(buds, and(eq(buds.budId, invocations.budId), eq(buds.createdByUserId, owner)))
      .where(and(eq(invocations.id, id), eq(invocations.createdByUserId, owner))).for("update", { of: invocations });
    return row?.invocation;
  }

  async get(owner: string, id: string) {
    const [row] = await this.database.select({ request: requests, key: keys }).from(requests)
      .leftJoin(keys, and(eq(keys.requestId, requests.id), eq(keys.createdByUserId, owner)))
      .where(and(eq(requests.id, id), eq(requests.createdByUserId, owner)));
    if (!row) throw notFound();
    return { ...serializeAppDataRequest(row.request), key: row.key ? serializeAppKey(row.key) : null };
  }

  async list(owner: string, query: { limit?: number; cursor?: string; pending_only?: boolean } = {}) {
    const limit = query.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > APP_KEY_LIMITS.page_size ||
      (query.pending_only !== undefined && typeof query.pending_only !== "boolean")) throw new DataRequestError(400, "invalid_app_data_query", "Invalid app data page");
    const binding = hash([owner, query.pending_only ?? false]);
    let before: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== "string" || query.cursor.length > 512) throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (value.binding !== binding || !/^dar_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.before)) throw new Error();
        before = value.before;
      } catch { throw new DataRequestError(400, "invalid_app_data_cursor", "Invalid app data cursor"); }
    }
    const rows = await this.database.select({ request: requests, key: keys }).from(requests)
      .leftJoin(keys, and(eq(keys.requestId, requests.id), eq(keys.createdByUserId, owner)))
      .where(and(eq(requests.createdByUserId, owner), before ? lt(requests.id, before) : undefined,
        query.pending_only ? eq(requests.status, "pending") : undefined))
      .orderBy(desc(requests.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(row => ({ ...serializeAppDataRequest(row.request), key: row.key ? serializeAppKey(row.key) : null })),
      next_cursor: rows.length > limit ? Buffer.from(JSON.stringify({ binding, before: page[page.length - 1].request.id })).toString("base64url") : null };
  }

  /** Context comes from the fenced runner, never the model or browser body. */
  async request(context: AppKeyRequestContext, input: unknown) {
    return this.database.transaction(tx => this.requestInTransaction(tx, context, input));
  }

  /** The runner also parks its action/invocation inside this same transaction. */
  async requestInTransaction(tx: Transaction, context: AppKeyRequestContext, input: unknown) {
    const value = parseAppKeyInput(appKeyRequestSchema, input);
    const definitionHash = hash(value);
      await this.lockOwner(tx, context.owner);
      const invocation = await this.activeInvocation(tx, context.owner, context.invocationId);
      if (!invocation) throw notFound();
      if (invocation.status !== "running" || invocation.workerId !== context.workerId || invocation.fence !== context.fence ||
        !invocation.leaseExpiresAt || invocation.leaseExpiresAt <= this.now() || invocation.cancelRequestedAt)
        throw new DataRequestError(409, "invocation_unavailable", "Invocation is no longer executing this request");
      const [action] = await tx.select().from(actions).where(and(eq(actions.invocationId, invocation.id),
        eq(actions.createdByUserId, context.owner), eq(actions.callId, context.callId), eq(actions.fence, context.fence),
        eq(actions.kind, APP_KEY_REQUEST_TOOL), eq(actions.status, "intent")));
      if (!action) throw new DataRequestError(409, "app_data_intent_required", "A current data permission tool intent is required");
      const [existing] = await tx.select().from(requests).where(and(eq(requests.invocationId, invocation.id),
        eq(requests.callId, context.callId), eq(requests.createdByUserId, context.owner)));
      if (existing) {
        if (existing.definitionHash !== definitionHash) throw conflict();
        return serializeAppDataRequest(existing);
      }
      if (!await this.validSite(tx, context.owner, value.destination.proxied_site_id, invocation.budId)) throw notFound();
      const [count] = await tx.select({ n: sql<number>`count(*)::integer` }).from(requests)
        .where(and(eq(requests.createdByUserId, context.owner), eq(requests.status, "pending"), gt(requests.expiresAt, this.now())));
      if (count.n >= APP_KEY_LIMITS.pending_requests_per_owner) throw new DataRequestError(409, "app_data_request_limit", "Resolve pending app data requests before creating more");
      const [row] = await tx.insert(requests).values({ id: `dar_${ulid()}`, invocationId: invocation.id,
        threadId: invocation.threadId, budId: invocation.budId, callId: context.callId,
        proxiedSiteId: value.destination.proxied_site_id, definition: value, definitionHash,
        createdByUserId: context.owner, tenantId: invocation.tenantId,
        expiresAt: new Date(this.now().getTime() + APP_KEY_LIMITS.setup_seconds * 1000) }).returning();
      return serializeAppDataRequest(row);
  }

  async decide(owner: string, id: string, input: unknown) {
    const value = parseAppKeyInput(appKeyDecisionSchema, input);
    await this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      const prior = await this.load(tx, owner, id);
      if (prior.decisionIdempotencyKey === value.idempotency_key) {
        if (hash(prior.decisionRequest) !== hash(value)) throw conflict();
        return;
      }
      if (prior.status !== "pending" || prior.version !== value.expected_version) throw conflict();
      const [used] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.createdByUserId, owner),
        eq(requests.decisionIdempotencyKey, value.idempotency_key)));
      if (used) throw conflict();
      const invocation = await this.activeInvocation(tx, owner, prior.invocationId);
      if (prior.expiresAt <= this.now() || !invocation || invocation.cancelRequestedAt ||
        !["running", "waiting_for_user"].includes(invocation.status)) {
        await tx.update(requests).set({ status: prior.expiresAt <= this.now() ? "expired" : "canceled",
          version: prior.version + 1, updatedAt: this.now() }).where(eq(requests.id, id));
        return;
      }
      if (value.decision === "approve") {
        if (!await this.validSite(tx, owner, prior.proxiedSiteId, prior.budId)) throw notFound();
        const [count] = await tx.select({ n: sql<number>`count(*)::integer` }).from(keys).where(and(eq(keys.createdByUserId, owner),
          sql`(${keys.status} = 'installed' or (${keys.status} = 'handoff_pending' and ${keys.setupExpiresAt} > ${this.now()}))`));
        if (count.n >= APP_KEY_LIMITS.active_keys_per_owner) throw new DataRequestError(409, "app_data_key_limit", "Revoke an unused app key before approving more");
        const recipient = definition(prior).destination.public_key;
        const issued = createAppQueryCredential();
        const expiry = new Date(this.now().getTime() + APP_KEY_LIMITS.setup_seconds * 1000);
        const envelope = sealAppQueryCredential(issued.credential, recipient, { request_id: id,
          key_id: issued.key_id, recipient_fingerprint: recipient.fingerprint, expires_at: expiry.toISOString() });
        await tx.insert(keys).values({ id: issued.key_id, requestId: id, verificationHash: issued.verification_hash,
          encryptedEnvelope: envelope, ciphertextDigest: envelope.ciphertext_sha256, setupExpiresAt: expiry,
          createdByUserId: owner, tenantId: prior.tenantId });
      }
      await tx.update(requests).set({ status: value.decision === "approve" ? "approved" : "declined",
        version: prior.version + 1, decisionRequest: value, decisionIdempotencyKey: value.idempotency_key,
        decidedByUserId: owner, decidedAt: this.now(), updatedAt: this.now() }).where(eq(requests.id, id));
      // The durable continuation polls this committed decision. No detached turn
      // is started here; integration must resume the original invocation/call.
    });
    return this.get(owner, id);
  }

  async revoke(owner: string, keyId: string, input: unknown) {
    const value = parseAppKeyInput(appKeyRevokeSchema, input);
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, owner);
      const [key] = await tx.select().from(keys).where(and(eq(keys.id, keyId), eq(keys.createdByUserId, owner)));
      if (!key) throw notFound();
      if (key.revokeRequest && hash(key.revokeRequest) === hash(value)) return serializeAppKey(key);
      if (key.version !== value.expected_version || !["handoff_pending", "installed"].includes(key.status)) throw conflict();
      const [row] = await tx.update(keys).set({ status: "revoked", encryptedEnvelope: null,
        revokedAt: this.now(), revokedByUserId: owner, revokeRequest: value, version: key.version + 1,
        outcomeCode: "owner_revoked", updatedAt: this.now() }).where(eq(keys.id, keyId)).returning();
      return serializeAppKey(row);
    });
  }

  /** App-backend-only signed delivery. Never feed this result to the agent. */
  async handoff(keyId: string, action: "retrieve" | "installed", input: unknown) {
    const proof = parseAppKeyInput(appKeyProofSchema, input);
    // Lookup supplies the candidate owner; possession is proved before returning
    // any state. This is separate from cookie/bearer first-party authorization.
    const [candidate] = await this.database.select({ owner: keys.createdByUserId }).from(keys).where(eq(keys.id, keyId));
    if (!candidate) throw notFound();
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, candidate.owner);
      const [key] = await tx.select().from(keys).where(and(eq(keys.id, keyId), eq(keys.createdByUserId, candidate.owner)));
      if (!key) throw notFound();
      const request = await this.load(tx, candidate.owner, key.requestId);
      const recipient = definition(request).destination.public_key;
      const context: AppKeyContext = { key_id: key.id, request_id: request.id,
        recipient_fingerprint: recipient.fingerprint, expires_at: key.setupExpiresAt.toISOString() };
      if (!verifyAppKeyProof(recipient, action, context, proof.signature, action === "installed" ? key.ciphertextDigest : undefined)) throw notFound();
      if (key.status !== "handoff_pending") return { status: key.status, key_id: key.id };
      const expired = key.setupExpiresAt <= this.now();
      const invalid = request.status !== "approved" || !await this.validSite(tx, candidate.owner, request.proxiedSiteId, request.budId);
      if (expired || invalid) {
        await tx.update(keys).set({ status: "setup_failed", encryptedEnvelope: null, revokedAt: this.now(),
          version: key.version + 1, outcomeCode: expired ? "setup_expired" : "destination_unavailable", updatedAt: this.now() }).where(eq(keys.id, key.id));
        return { status: "setup_failed", key_id: key.id };
      }
      if (action === "retrieve") return { status: "handoff_pending", key_id: key.id,
        envelope: key.encryptedEnvelope as unknown as AppKeyEnvelope };
      await tx.update(keys).set({ status: "installed", encryptedEnvelope: null, installedAt: this.now(),
        version: key.version + 1, updatedAt: this.now() }).where(eq(keys.id, key.id));
      return { status: "installed", key_id: key.id };
    });
  }

  async authenticate(credential: unknown): Promise<AppKeyAuthority> {
    if (typeof credential !== "string" || !/^dak_[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/.test(credential)) throw denied();
    const keyId = credential.slice(0, credential.indexOf("."));
    const [row] = await this.database.select({ key: keys, request: requests }).from(keys)
      .innerJoin(requests, and(eq(requests.id, keys.requestId), eq(requests.createdByUserId, keys.createdByUserId)))
      .where(and(eq(keys.id, keyId), eq(keys.status, "installed"), eq(requests.status, "approved")));
    if (!row || !verifyAppQueryCredential(credential, keyId, row.key.verificationHash) ||
      !await this.validSite(this.database, row.key.createdByUserId, row.request.proxiedSiteId, row.request.budId)) throw denied();
    return { owner: row.key.createdByUserId, keyId, version: row.key.version, policy: definition(row.request).data_access };
  }

  /** Call after each query, immediately before release; no positive auth cache. */
  async confirmCurrent(authority: AppKeyAuthority) {
    await this.database.transaction(async tx => {
      await this.lockOwner(tx, authority.owner);
      const [row] = await tx.select({ key: keys, request: requests }).from(keys)
        .innerJoin(requests, and(eq(requests.id, keys.requestId), eq(requests.createdByUserId, authority.owner)))
        .where(and(eq(keys.id, authority.keyId), eq(keys.createdByUserId, authority.owner),
          eq(keys.version, authority.version), eq(keys.status, "installed"), eq(requests.status, "approved")));
      if (!row || !await this.validSite(tx, authority.owner, row.request.proxiedSiteId, row.request.budId) ||
        hash(definition(row.request).data_access) !== hash(authority.policy)) throw denied();
      await tx.update(keys).set({ lastUsedAt: this.now() }).where(eq(keys.id, authority.keyId));
    });
  }

  /** Bounded persisted expiry; composition must schedule it even with closed clients. */
  async expireNext(owner?: string): Promise<boolean> {
    const now = this.now();
    const [candidate] = await this.database.select({ owner: requests.createdByUserId }).from(requests)
      .where(and(owner ? eq(requests.createdByUserId, owner) : undefined, eq(requests.status, "pending"), lt(requests.expiresAt, now)))
      .orderBy(requests.expiresAt).limit(1);
    const [keyCandidate] = candidate ? [] : await this.database.select({ owner: keys.createdByUserId }).from(keys)
      .where(and(owner ? eq(keys.createdByUserId, owner) : undefined, eq(keys.status, "handoff_pending"), lt(keys.setupExpiresAt, now)))
      .orderBy(keys.setupExpiresAt).limit(1);
    const target = candidate ?? keyCandidate;
    if (!target) return false;
    return this.database.transaction(async tx => {
      await this.lockOwner(tx, target.owner);
      const pending = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.createdByUserId, target.owner),
        eq(requests.status, "pending"), lt(requests.expiresAt, now))).orderBy(requests.expiresAt).limit(100);
      const uninstalled = await tx.select({ id: keys.id }).from(keys).where(and(eq(keys.createdByUserId, target.owner),
        eq(keys.status, "handoff_pending"), lt(keys.setupExpiresAt, now))).orderBy(keys.setupExpiresAt).limit(100);
      if (pending.length) await tx.update(requests).set({ status: "expired", version: sql`${requests.version} + 1`, updatedAt: now })
        .where(inArray(requests.id, pending.map(row => row.id)));
      if (uninstalled.length) await tx.update(keys).set({ status: "setup_failed", encryptedEnvelope: null, revokedAt: now,
        version: sql`${keys.version} + 1`, outcomeCode: "setup_expired", updatedAt: now }).where(inArray(keys.id, uninstalled.map(row => row.id)));
      return pending.length + uninstalled.length > 0;
    });
  }
}
