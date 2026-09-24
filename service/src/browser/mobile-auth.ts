import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { pool } from "../db/client.js";
import type { Pool } from "pg";
import type { BrowserSession } from "./control-repository.js";

export const mobileCookie = "__Secure-bud-browser-visit";
export const visitLifetimeMs = 15 * 60_000;
export const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");
export type MobileVisit = { id: string; session_id: string; viewer_id: string; created_by_user_id: string };

/** A visit survives service restart, but never authenticates any non-browser route. */
export class BrowserMobileAuth {
  constructor(private readonly database: Pool = pool) {}
  async mint(session: BrowserSession, viewerId: string) {
    const id = ulid(), grant = randomBytes(32).toString("base64url");
    await this.database.query("delete from browser_viewer_visit where created_by_user_id=$1 and absolute_expires_at<now()", [session.created_by_user_id]);
    await this.database.query(`insert into browser_viewer_visit
      (id,session_id,thread_id,bud_id,viewer_id,created_by_user_id,tenant_id,grant_hash,grant_expires_at,expires_at,absolute_expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '60 seconds',now()+interval '15 minutes',now()+interval '8 hours')`,
      [id,session.id,session.thread_id,session.bud_id,viewerId,session.created_by_user_id,session.tenant_id,hashSecret(grant)]);
    return {visit_id:id, grant, expires_in:60};
  }
  async redeem(grant: string) {
    const token = randomBytes(32).toString("base64url");
    const visit = (await this.database.query<MobileVisit>(`update browser_viewer_visit set consumed_at=now(),token_hash=$2
      where grant_hash=$1 and consumed_at is null and grant_expires_at>now() returning *`, [hashSecret(grant),hashSecret(token)])).rows[0];
    return visit ? {visit,token} : null;
  }
  async resolve(token: string): Promise<MobileVisit | null> {
    if (!/^[\w-]{43}$/.test(token)) return null;
    return (await this.database.query<MobileVisit>(`select v.* from browser_viewer_visit v
      join browser_session s on s.id=v.session_id
      join browser_resource r on r.id=s.browser_id and r.retired_at is null
      join thread t on t.thread_id=v.thread_id and t.deleted_at is null
      join bud b on b.bud_id=v.bud_id
      where v.token_hash=$1 and v.expires_at>now() and v.absolute_expires_at>now()
      and s.closed_at is null and s.created_by_user_id=v.created_by_user_id
      and t.created_by_user_id=v.created_by_user_id and b.created_by_user_id=v.created_by_user_id`, [hashSecret(token)])).rows[0] ?? null;
  }
  async refresh(owner: string, id: string, grant: string) {
    // Native possession proof is separate from the cookie and never reaches JS.
    return (await this.database.query(`update browser_viewer_visit set expires_at=least(absolute_expires_at,now()+interval '15 minutes')
      where id=$1 and created_by_user_id=$2 and grant_hash=$3 and consumed_at is not null
      and expires_at>now() and absolute_expires_at>now() returning id`, [id,owner,hashSecret(grant)])).rowCount === 1;
  }
  async revoke(owner: string, id: string) {
    await this.database.query("delete from browser_viewer_visit where id=$1 and created_by_user_id=$2", [id,owner]);
  }
}
export function scopedBrowserOperation(operation: string) {
  return ["acquire","renew","release","return","recover"].includes(operation);
}
