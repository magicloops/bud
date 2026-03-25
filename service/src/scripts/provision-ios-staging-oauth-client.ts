import { runIosOAuthProvisioning } from "./provision-ios-oauth-client-shared.js";

async function main() {
  await runIosOAuthProvisioning({
    environment: "staging",
    clientId: "bud-ios-staging",
    clientRowId: "oauth_client_bud_ios_staging",
    clientName: "Bud iOS (staging)",
    redirectUri: "chat.bud.app://oauth/callback",
    expectedAppOrigin: "https://staging.bud.dev",
    expectedIssuer: "https://staging.bud.dev/api/auth",
    expectedAudience: "https://staging.bud.dev/api",
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
