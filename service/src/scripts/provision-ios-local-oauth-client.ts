import { getIosOAuthRedirectUri } from "./ios-oauth-contract.js";
import { runIosOAuthProvisioning } from "./provision-ios-oauth-client-shared.js";

async function main() {
  await runIosOAuthProvisioning({
    environment: "local",
    clientId: "bud-ios-dev-local",
    clientRowId: "oauth_client_bud_ios_dev_local",
    clientName: "Bud iOS (dev)",
    redirectUri: getIosOAuthRedirectUri("local"),
    expectedAppOrigin: [
      "http://localhost:5173",
      "https://localhost:3443",
    ],
    expectedIssuer: [
      "http://localhost:5173/api/auth",
      "https://localhost:3443/api/auth",
    ],
    expectedAudience: [
      "http://localhost:5173/api",
      "https://localhost:3443/api",
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
