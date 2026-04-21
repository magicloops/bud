import "dotenv/config";
import { eq } from "drizzle-orm";
import { AUTH_BASE_PATH, OAUTH_PROVIDER_SCOPES, authPool } from "../auth/auth.js";
import { config } from "../config.js";
import { db, pool } from "../db/client.js";
import { authOAuthClientTable } from "../db/schema.js";

export type IosOAuthProvisionEnvironment = "local" | "staging";

export type IosOAuthProvisionConfig = {
  environment: IosOAuthProvisionEnvironment;
  clientId: string;
  clientRowId: string;
  clientName: string;
  redirectUri: string;
  expectedAppOrigin: string;
  expectedIssuer: string;
  expectedAudience: string;
};

type IosAuthBundle = {
  environment: IosOAuthProvisionEnvironment;
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

function formatYaml(bundle: IosAuthBundle): string {
  const scopeLines = bundle.scopes.map((scope) => `  - ${scope}`).join("\n");

  return [
    `environment: ${bundle.environment}`,
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

function buildIosAuthBundle(provisionConfig: IosOAuthProvisionConfig): IosAuthBundle {
  const issuer = buildUrl(config.betterAuthUrl, AUTH_BASE_PATH);

  return {
    environment: provisionConfig.environment,
    app_origin: config.appBaseUrl,
    issuer,
    client_id: provisionConfig.clientId,
    redirect_uri: provisionConfig.redirectUri,
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
      "Send client_id on POST /api/me/oauth/revoke. Mobile sign-out uses token revocation; RP-initiated logout is not required for this tranche.",
  };
}

async function upsertIosClient(provisionConfig: IosOAuthProvisionConfig): Promise<"created" | "updated"> {
  const existing = await db.query.authOAuthClientTable.findFirst({
    where: eq(authOAuthClientTable.clientId, provisionConfig.clientId),
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
    name: provisionConfig.clientName,
    uri: config.appBaseUrl,
    redirectUris: [provisionConfig.redirectUri],
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
      environment: provisionConfig.environment,
    },
    updatedAt: now,
  };

  if (existing) {
    await db
      .update(authOAuthClientTable)
      .set(sharedValues)
      .where(eq(authOAuthClientTable.clientId, provisionConfig.clientId));

    return "updated";
  }

  await db.insert(authOAuthClientTable).values({
    id: provisionConfig.clientRowId,
    clientId: provisionConfig.clientId,
    createdAt: now,
    ...sharedValues,
  });

  return "created";
}

function printWarnings(bundle: IosAuthBundle, provisionConfig: IosOAuthProvisionConfig): void {
  const warnings: string[] = [];
  const actualAuthOrigin = bundle.issuer.replace(AUTH_BASE_PATH, "");

  if (bundle.app_origin !== actualAuthOrigin) {
    warnings.push(
      `APP_BASE_URL (${bundle.app_origin}) and BETTER_AUTH_URL (${actualAuthOrigin}) differ.`,
    );
  }

  if (bundle.app_origin !== provisionConfig.expectedAppOrigin) {
    warnings.push(
      `APP_BASE_URL is ${bundle.app_origin}. The ${provisionConfig.environment} iOS handoff expects ${provisionConfig.expectedAppOrigin} as the public app origin.`,
    );
  }

  if (bundle.issuer !== provisionConfig.expectedIssuer) {
    warnings.push(
      `Issuer is ${bundle.issuer}. The ${provisionConfig.environment} iOS handoff expects ${provisionConfig.expectedIssuer}.`,
    );
  }

  if (bundle.audience !== provisionConfig.expectedAudience) {
    warnings.push(
      `API audience is ${bundle.audience}. The ${provisionConfig.environment} iOS handoff expects ${provisionConfig.expectedAudience}.`,
    );
  }

  for (const warning of warnings) {
    console.warn(`WARNING: ${warning}`);
  }
}

export async function runIosOAuthProvisioning(
  provisionConfig: IosOAuthProvisionConfig,
): Promise<void> {
  try {
    const result = await upsertIosClient(provisionConfig);
    const bundle = buildIosAuthBundle(provisionConfig);

    printWarnings(bundle, provisionConfig);

    console.log(`status: ${result}`);
    console.log(`client_id: ${provisionConfig.clientId}`);
    console.log(`redirect_uri: ${provisionConfig.redirectUri}`);
    console.log("");
    console.log(`# ${provisionConfig.environment[0].toUpperCase()}${provisionConfig.environment.slice(1)} iOS auth bundle`);
    console.log(formatYaml(bundle));
  } finally {
    await authPool.end();
    await pool.end();
  }
}
