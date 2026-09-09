import type { Pool, PoolClient } from "pg";

export function readInvocationSettings(env: NodeJS.ProcessEnv = process.env) {
  const cap = Number(env.AGENT_AUTOMATION_CONCURRENCY_PER_BUD ?? "1");
  if (!Number.isInteger(cap) || cap < 1 || cap > 32) throw new Error("invalid_automation_concurrency_per_bud");
  // Rolled-out capabilities are standard behavior. Retired rollout flags are
  // deliberately ignored so stale deployment settings cannot hide agent tools.
  return { mode: "durable", automationConcurrencyPerBud: cap, automationsEnabled: true,
    appKeysEnabled: true, automationProposalsEnabled: true, bootstrapProposalsEnabled: true } as const;
}

/** Fail boot before worker admission or HTTP capability publication on an old schema. */
export async function verifyAutomationProposalSchema(database: Pick<Pool, "query">): Promise<void> {
  await database.query(`select id, automation_id, invocation_id, thread_id, bud_id, call_id,
    definition, draft_version, grant_version, version, status, activated_revision,
    decision_request, decision_idempotency_key, decided_by_user_id, decided_at,
    expires_at, created_by_user_id, tenant_id, created_at, updated_at
    from automation_proposal limit 0`);
}

/** Required even with issuance disabled: claim/state reads recover existing reviews. */
export async function verifyBootstrapProposalSchema(database: Pick<Pool, "query">): Promise<void> {
  await database.query(`select id, automation_id, revision, invocation_id, thread_id, bud_id,
    call_id, frozen, fingerprint, member_count, version, status, bootstrap_id,
    decision_request, decision_idempotency_key, decided_by_user_id, decided_at,
    expires_at, created_by_user_id, tenant_id, created_at, updated_at
    from automation_bootstrap_proposal limit 0`);
  await database.query(`select proposal_id, ordinal, contact_revision_id, created_by_user_id, tenant_id
    from automation_bootstrap_proposal_member limit 0`);
}

// Dedicated session: transaction-poolers cannot preserve these locks. The
// transaction lock serializes mode acquisition; shared session locks allow
// multiple processes in one mode and exclude the opposite mode.
export async function acquireInvocationMode(
  pool: Pick<Pool, "connect">,
  mode: "legacy" | "durable",
  onLost: () => void,
): Promise<() => Promise<void>> {
  const client: PoolClient = await pool.connect();
  let released = false;
  const lost = () => { if (!released) onLost(); };
  client.on("error", lost);
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('bud-invocation-mode:' || current_schema()), 0)");
    const own = mode === "legacy" ? 1 : 2;
    const opposite = mode === "legacy" ? 2 : 1;
    const lock = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('bud-invocation-mode:' || current_schema()), $1) as acquired", [opposite]);
    if (!lock.rows[0]?.acquired) throw new Error("agent_invocation_mode_conflict");
    await client.query("select pg_advisory_unlock(hashtext('bud-invocation-mode:' || current_schema()), $1)", [opposite]);
    const table = await client.query<{ present: boolean }>(
      "select to_regclass('agent_invocation') is not null as present");
    if (!table.rows[0]?.present) {
      if (mode === "durable") throw new Error("agent_invocation_migrations_required");
    } else if (mode === "legacy") {
      const unresolved = await client.query(`select 1 from agent_invocation
        where reserves_thread or status not in ('succeeded', 'failed', 'canceled', 'expired') limit 1`);
      if (unresolved.rowCount) throw new Error("durable_invocations_require_reconciliation");
    } else {
      const pending = await client.query(`select 1 from agent_question_request q
        where q.status = 'pending' and not exists (select 1 from agent_invocation i
          where i.thread_id = q.thread_id and i.turn_id = q.turn_id) limit 1`);
      if (pending.rowCount) throw new Error("legacy_questions_require_drain");
    }
    await client.query("select pg_advisory_lock_shared(hashtext('bud-invocation-mode:' || current_schema()), $1)", [own]);
    await client.query("commit");
    return async () => {
      if (released) return;
      released = true;
      client.removeListener("error", lost);
      // Destroy the dedicated connection; session locks cannot leak into the pool.
      client.release(true);
    };
  } catch (error) {
    released = true;
    client.removeListener("error", lost);
    client.release(true);
    throw error;
  }
}
