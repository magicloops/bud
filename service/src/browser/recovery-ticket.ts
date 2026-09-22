import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { BrowserSession } from "./control-repository.js";
import { BrowserError } from "./repository.js";

type Claims = {
  owner: string; viewer: string; session: string; generation: string;
  boot: string; epoch: number; expires: number;
};

/** A viewer-bound proof of prior control, never a substitute for authentication. */
export class BrowserRecoveryTickets {
  private readonly key: Buffer;
  constructor(secret = config.betterAuthSecret, private readonly now = Date.now) {
    this.key = createHmac("sha256", secret).update("bud/browser-viewer-recovery/v1").digest();
  }
  issue(session: BrowserSession, viewer: string): string {
    const claims: Claims = { owner: session.created_by_user_id, viewer, session: session.id,
      generation: session.generation, boot: session.boot_id, epoch: session.control_epoch,
      expires: this.now() + 10 * 60_000 };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${this.sign(body).toString("base64url")}`;
  }
  verify(token: string, session: BrowserSession, viewer: string): Claims {
    try {
      if (token.length > 2048) throw new Error();
      const [body, signature, extra] = token.split(".");
      const supplied = Buffer.from(signature ?? "", "base64url");
      if (!body || extra !== undefined || supplied.length !== 32 || !timingSafeEqual(supplied, this.sign(body))) throw new Error();
      const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Claims;
      if (claims.owner !== session.created_by_user_id || claims.viewer !== viewer ||
          claims.session !== session.id || claims.generation !== session.generation ||
          claims.boot !== session.boot_id || !Number.isSafeInteger(claims.epoch) ||
          !Number.isFinite(claims.expires) || claims.expires <= this.now()) throw new Error();
      return claims;
    } catch { throw new BrowserError("browser_recovery_invalid"); }
  }
  private sign(body: string) { return createHmac("sha256", this.key).update(body).digest(); }
}
