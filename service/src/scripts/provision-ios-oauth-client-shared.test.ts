import assert from "node:assert/strict";
import test from "node:test";
import {
  getIosOAuthRedirectUri,
  IOS_OAUTH_CLIENT_IDS,
  IOS_OAUTH_CLIENT_ROW_IDS,
  IOS_OAUTH_REDIRECT_URIS,
} from "./ios-oauth-contract.js";

test("non-production iOS OAuth provisioning uses staging callback and client ids", () => {
  assert.equal(IOS_OAUTH_REDIRECT_URIS.local, "chat.bud.app.staging://oauth/callback");
  assert.equal(IOS_OAUTH_REDIRECT_URIS.staging, "chat.bud.app.staging://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("local"), "chat.bud.app.staging://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("staging"), "chat.bud.app.staging://oauth/callback");
  assert.equal(IOS_OAUTH_CLIENT_IDS.local, "bud-ios-dev-local");
  assert.equal(IOS_OAUTH_CLIENT_IDS.staging, "bud-ios-staging");
  assert.equal(IOS_OAUTH_CLIENT_ROW_IDS.local, "oauth_client_bud_ios_dev_local");
  assert.equal(IOS_OAUTH_CLIENT_ROW_IDS.staging, "oauth_client_bud_ios_staging");
});

test("production iOS OAuth provisioning uses the production callback scheme", () => {
  assert.equal(IOS_OAUTH_REDIRECT_URIS.production, "chat.bud.app://oauth/callback");
  assert.equal(getIosOAuthRedirectUri("production"), "chat.bud.app://oauth/callback");
  assert.equal(IOS_OAUTH_CLIENT_IDS.production, "bud-ios");
  assert.equal(IOS_OAUTH_CLIENT_ROW_IDS.production, "oauth_client_bud_ios");
});
