import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { CALENDAR_SCOPES, type GoogleConfig } from "./config.js";

export function googleFixture() {
  const config: GoogleConfig = { clientId: "fixture.apps.googleusercontent.com", clientSecret: "fixture-secret",
    redirectUri: "https://bud.example/api/google/callback" };
  const codes = new Map<string, { challenge: string; scopes: string[] }>();
  const grants = new Map<string, string[]>();
  const calls: { owner: string; method: string; url: string; body: unknown; etag: string | null }[] = [];
  let refreshCount = 0, loseReply = false, status = 200, partialScopes = false, omitRefresh = false;
  let explicitScopes: string[] | undefined, refreshedScopes: string[] | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_id"), config.clientId);
      assert.equal(body.get("client_secret"), config.clientSecret);
      if (body.get("grant_type") === "refresh_token") {
        refreshCount++;
        return Response.json({ access_token: body.get("refresh_token")!.replace("refresh-", ""), expires_in: 3600,
          token_type: "Bearer", scope: (refreshedScopes ?? grants.get(body.get("refresh_token")!.replace("refresh-", "")) ?? CALENDAR_SCOPES).join(" ") });
      }
      const code = body.get("code")!;
      assert.equal(body.get("redirect_uri"), config.redirectUri);
      const flow = codes.get(code)!;
      assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), flow.challenge);
      codes.delete(code);
      const scopes = explicitScopes ?? (partialScopes ? ["openid", "email"] : [...new Set([...(grants.get(code) ?? []), ...flow.scopes])]);
      if (!partialScopes) grants.set(code, scopes);
      return Response.json({ access_token: code, ...(!omitRefresh ? { refresh_token: `refresh-${code}` } : {}), token_type: "Bearer", expires_in: 3600,
        scope: scopes.join(" ") });
    }
    const owner = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({ sub: `google-${owner}`, email: `${owner}@example.com`, email_verified: true });
    }
    assert.ok(["https://www.googleapis.com", "https://gmail.googleapis.com"].includes(url.origin));
    calls.push({ owner, method: request.method, url: url.href,
      body: request.body ? request.headers.get("content-type")?.startsWith("multipart/") ? await request.arrayBuffer() : JSON.parse(await request.text()) : null, etag: request.headers.get("if-match") });
    if (loseReply) throw new Error("Synthetic lost Calendar response");
    if (status !== 200) return Response.json({ error: { message: "Must not reach model/logs" } }, { status });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method === "POST" || request.method === "PATCH") return Response.json({ id: "event", summary: `event for ${owner}`, etag: '"etag2"' });
    return Response.json({ items: [{ id: "event", summary: `event for ${owner}`, etag: '"etag1"' }], nextPageToken: "next-page" });
  };
  return { config, fetcher, calls, get refreshCount() { return refreshCount; },
    authorize(url: string, owner: string) {
      const params = new URL(url).searchParams;
      codes.set(owner, { challenge: params.get("code_challenge")!, scopes: params.get("scope")!.split(" ") });
    },
    loseReply() { loseReply = true; }, reject(code: number) { status = code; },
    grantOnly(scopes?: string[]) { explicitScopes = scopes; }, refreshedScopes(scopes?: string[]) { refreshedScopes = scopes; },
    partialScopes(value = true) { partialScopes = value; }, omitRefresh(value = true) { omitRefresh = value; } };
}
