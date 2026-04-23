import { getIosOAuthRedirectUri } from "./ios-oauth-contract.js";
import { runIosOAuthProvisioning } from "./provision-ios-oauth-client-shared.js";

async function main() {
  await runIosOAuthProvisioning({
    environment: "local",
    clientId: "bud-ios-dev-local",
    clientRowId: "oauth_client_bud_ios_dev_local",
    clientName: "Bud iOS (dev)",
    redirectUri: getIosOAuthRedirectUri("local"),
    expectedAppOrigin: "http://localhost:5173",
    expectedIssuer: "http://localhost:5173/api/auth",
    expectedAudience: "http://localhost:5173/api",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
