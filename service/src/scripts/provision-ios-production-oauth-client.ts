import {
  getIosOAuthRedirectUri,
  IOS_OAUTH_CLIENT_IDS,
  IOS_OAUTH_CLIENT_ROW_IDS,
} from "./ios-oauth-contract.js";
import { runIosOAuthProvisioning } from "./provision-ios-oauth-client-shared.js";

async function main() {
  await runIosOAuthProvisioning({
    environment: "production",
    clientId: IOS_OAUTH_CLIENT_IDS.production,
    clientRowId: IOS_OAUTH_CLIENT_ROW_IDS.production,
    clientName: "Bud iOS",
    redirectUri: getIosOAuthRedirectUri("production"),
    expectedAppOrigin: "https://app.bud.dev",
    expectedIssuer: "https://app.bud.dev/api/auth",
    expectedAudience: "https://app.bud.dev/api",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
