import assert from "node:assert/strict";
import test from "node:test";
import { getIosOAuthRedirectUri, IOS_OAUTH_REDIRECT_URIS } from "./ios-oauth-contract.js";

test("non-production iOS OAuth provisioning uses the staging callback scheme", () => {
  assert.equal(IOS_OAUTH_REDIRECT_URIS.local, "chat.bud.app.staging://oauth/callback");
  assert.equal(IOS_OAUTH_REDIRECT_URIS.staging, "chat.bud.app.staging://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("local"), "chat.bud.app.staging://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("staging"), "chat.bud.app.staging://oauth/callback");
});

test("production iOS OAuth provisioning keeps the production callback scheme", () => {
  assert.equal(IOS_OAUTH_REDIRECT_URIS.production, "chat.bud.app://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("production"), "chat.bud.app://oauth/callback");
});
