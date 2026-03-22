import "dotenv/config";
import { eq } from "drizzle-orm";
import { AUTH_BASE_PATH, OAUTH_PROVIDER_SCOPES, authPool } from "../auth/auth.js";
import { config } from "../config.js";
import { db, pool } from "../db/client.js";
import { authOAuthClientTable } from "../db/schema.js";

const LOCAL_IOS_CLIENT_ID = "bud-ios-dev-local";
const LOCAL_IOS_CLIENT_ROW_ID = "oauth_client_bud_ios_dev_local";
const LOCAL_IOS_CLIENT_NAME = "Bud iOS (dev)";
const LOCAL_IOS_REDIRECT_URI = "chat.bud.app://oauth/callback";

type LocalAuthBundle = {
  environment: "local";
  app_origin: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  openid_configuration_url: string;
  authorization_server_metadata_url: string;
  protected_resource_metadata_url: string;
  audience: string;
  scopes: string[];
  trusted_client: boolean;
  logout_notes: string;
};

function buildUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

function getProtectedResourceMetadataUrl(base: string, audience: string): string {
  try {
    const { pathname } = new URL(audience);
    const normalizedPath = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    return buildUrl(
      base,
      `/.well-known/oauth-protected-resource${normalizedPath === "/" ? "" : normalizedPath}`,
    );
  } catch {
    return buildUrl(base, "/.well-known/oauth-protected-resource");
  }
}

function formatYaml(bundle: LocalAuthBundle): string {
  const scopeLines = bundle.scopes.map((scope) => `  - ${scope}`).join("\n");

  return [
    "environment: local",
    `app_origin: ${bundle.app_origin}`,
    `issuer: ${bundle.issuer}`,
    `client_id: ${bundle.client_id}`,
    `redirect_uri: ${bundle.redirect_uri}`,
    `authorization_endpoint: ${bundle.authorization_endpoint}`,
    `token_endpoint: ${bundle.token_endpoint}`,
    `userinfo_endpoint: ${bundle.userinfo_endpoint}`,
    `jwks_uri: ${bundle.jwks_uri}`,
    `openid_configuration_url: ${bundle.openid_configuration_url}`,
    `authorization_server_metadata_url: ${bundle.authorization_server_metadata_url}`,
    `protected_resource_metadata_url: ${bundle.protected_resource_metadata_url}`,
    `audience: ${bundle.audience}`,
    "scopes:",
    scopeLines,
    `trusted_client: ${bundle.trusted_client ? "true" : "false"}`,
    `logout_notes: ${bundle.logout_notes}`,
  ].join("\n");
}

function buildLocalAuthBundle(): LocalAuthBundle {
  const issuer = buildUrl(config.betterAuthUrl, AUTH_BASE_PATH);

  return {
    environment: "local",
    app_origin: config.appBaseUrl,
    issuer,
    client_id: LOCAL_IOS_CLIENT_ID,
    redirect_uri: LOCAL_IOS_REDIRECT_URI,
    authorization_endpoint: buildUrl(config.betterAuthUrl, `${AUTH_BASE_PATH}/oauth2/authorize`),
    token_endpoint: buildUrl(config.betterAuthUrl, `${AUTH_BASE_PATH}/oauth2/token`),
    userinfo_endpoint: buildUrl(config.betterAuthUrl, `${AUTH_BASE_PATH}/oauth2/userinfo`),
    jwks_uri: buildUrl(config.betterAuthUrl, `${AUTH_BASE_PATH}/jwks`),
    openid_configuration_url: buildUrl(
      config.betterAuthUrl,
      `${AUTH_BASE_PATH}/.well-known/openid-configuration`,
    ),
    authorization_server_metadata_url: buildUrl(
      config.betterAuthUrl,
      `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
    ),
    protected_resource_metadata_url: getProtectedResourceMetadataUrl(
      config.betterAuthUrl,
      config.apiAudience,
    ),
    audience: config.apiAudience,
    scopes: [...OAUTH_PROVIDER_SCOPES],
    trusted_client: true,
    logout_notes:
      "Send client_id on POST /api/me/oauth/revoke. Local sign-out uses token revocation; RP-initiated logout is not required for this tranche.",
  };
}

async function upsertLocalIosClient(): Promise<"created" | "updated"> {
  const existing = await db.query.authOAuthClientTable.findFirst({
    where: eq(authOAuthClientTable.clientId, LOCAL_IOS_CLIENT_ID),
  });

  const now = new Date();
  const sharedValues = {
    clientSecret: null,
    disabled: false,
    skipConsent: true,
    enableEndSession: true,
    subjectType: "public" as const,
    scopes: [...OAUTH_PROVIDER_SCOPES],
    userId: null,
    name: LOCAL_IOS_CLIENT_NAME,
    uri: config.appBaseUrl,
    redirectUris: [LOCAL_IOS_REDIRECT_URI],
    postLogoutRedirectUris: null,
    tokenEndpointAuthMethod: "none" as const,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    public: true,
    type: "native" as const,
    requirePKCE: true,
    referenceId: null,
    metadata: {
      platform: "ios",
      environment: "local",
    },
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(authOAuthClientTable)
      .set(sharedValues)
      .where(eq(authOAuthClientTable.clientId, LOCAL_IOS_CLIENT_ID));

    return "updated";
  }

  await db.insert(authOAuthClientTable).values({
    id: LOCAL_IOS_CLIENT_ROW_ID,
    clientId: LOCAL_IOS_CLIENT_ID,
    createdAt: now,
    ...sharedValues,
  });

  return "created";
}

function printWarnings(bundle: LocalAuthBundle): void {
  const warnings: string[] = [];

  if (bundle.app_origin !== bundle.issuer.replace(AUTH_BASE_PATH, "")) {
    warnings.push(
      `APP_BASE_URL (${bundle.app_origin}) and BETTER_AUTH_URL (${bundle.issuer.replace(AUTH_BASE_PATH, "")}) differ.`,
    );
  }

  if (bundle.app_origin !== "http://localhost:5173") {
    warnings.push(
      `APP_BASE_URL is ${bundle.app_origin}. The local iOS handoff expects http://localhost:5173 as the public app origin.`,
    );
  }

  if (bundle.issuer !== "http://localhost:5173/api/auth") {
    warnings.push(
      `Issuer is ${bundle.issuer}. The local iOS handoff expects http://localhost:5173/api/auth.`,
    );
  }

  if (bundle.audience !== "http://localhost:5173/api") {
    warnings.push(
      `API audience is ${bundle.audience}. The local iOS handoff expects http://localhost:5173/api.`,
    );
  }

  for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`);
  }
}

async function main() {
  try {
    const result = await upsertLocalIosClient();
    const bundle = buildLocalAuthBundle();

    printWarnings(bundle);

    console.log(`status: ${result}`);
    console.log(`client_id: ${LOCAL_IOS_CLIENT_ID}`);
    console.log(`redirect_uri: ${LOCAL_IOS_REDIRECT_URI}`);
    console.log("");
    console.log("# Local iOS auth bundle");
    console.log(formatYaml(bundle));
  } finally {
    await authPool.end();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
