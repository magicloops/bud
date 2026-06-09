import {
  getIosOAuthRedirectUri,
  IOS_OAUTH_CLIENT_IDS,
  IOS_OAUTH_CLIENT_ROW_IDS,
} from "./ios-oauth-contract.js";
import { runIosOAuthProvisioning } from "./provision-ios-oauth-client-shared.js";

async function main() {
  await runIosOAuthProvisioning({
    environment: "staging",
    clientId: IOS_OAUTH_CLIENT_IDS.staging,
    clientRowId: IOS_OAUTH_CLIENT_ROW_IDS.staging,
    clientName: "Bud iOS (staging)",
    redirectUri: getIosOAuthRedirectUri("staging"),
    expectedAppOrigin: "https://staging.bud.dev",
    expectedIssuer: "https://staging.bud.dev/api/auth",
    expectedAudience: "https://staging.bud.dev/api",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
