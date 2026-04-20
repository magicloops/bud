import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { config } from "../config.js";
import { Pool } from "pg";

export const AUTH_BASE_PATH = config.betterAuthBasePath;
export const OAUTH_PROVIDER_SCOPES = ["openid", "profile", "email", "offline_access", "api"] as const;
export const MOBILE_API_SCOPE = "api";
const AUTH_ISSUER = new URL(AUTH_BASE_PATH, `${config.betterAuthUrl}/`).toString();

export const authHandlerPoolOptions = {
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  options: "-c search_path=auth",
};

export const authPool = new Pool(authHandlerPoolOptions);

const enabledSocialProviders = Object.fromEntries(
  Object.entries({
    github:
      config.githubClientId && config.githubClientSecret
        ? {
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
            scope: ["user:email"],
            mapProfileToUser: (profile: Record<string, unknown>) => {
              const login = typeof profile.login === "string" ? profile.login : "";
              return login ? { name: login } : {};
            },
          }
        : undefined,
    google:
      config.googleClientId && config.googleClientSecret
        ? {
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
            prompt: "select_account",
          }
        : undefined,
  }).filter(([, provider]) => provider),
);

function getOAuthAuthorizationServerMetadataPath(basePath: string): string {
  return `/.well-known/oauth-authorization-server${basePath === "/" ? "" : basePath}`;
}

function getOpenIdConfigurationPath(basePath: string): string {
  const normalizedBasePath = basePath === "/" ? "" : basePath;
  return `${normalizedBasePath}${normalizedBasePath.endsWith("/") ? "" : "/"}${".well-known/openid-configuration"}`;
}

function getProtectedResourceMetadataPath(resource: string): string {
  try {
    const { pathname } = new URL(resource);
    const normalizedPath = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    return `/.well-known/oauth-protected-resource${normalizedPath === "/" ? "" : normalizedPath}`;
  } catch {
    return "/.well-known/oauth-protected-resource";
  }
}

export function createAuthOptions(database: Pool): Parameters<typeof betterAuth>[0] {
  return {
    database,
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: config.betterAuthTrustedOrigins,
    disabledPaths: ["/token"],
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
    },
    account: {
      updateAccountOnSignIn: true,
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "google"],
        allowDifferentEmails: false,
        disableImplicitLinking: false,
      },
    },
    socialProviders: enabledSocialProviders,
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
      }),
      oauthProvider({
        loginPage: config.oauthLoginPagePath,
        consentPage: config.oauthConsentPagePath,
        scopes: [...OAUTH_PROVIDER_SCOPES],
        grantTypes: ["authorization_code", "refresh_token"],
        validAudiences: [config.apiAudience],
        cachedTrustedClients: new Set(config.oauthTrustedClientIds),
        advertisedMetadata: {
          scopes_supported: [...OAUTH_PROVIDER_SCOPES],
        },
        silenceWarnings: {
          oauthAuthServerConfig: true,
          openidConfig: true,
        },
      }),
    ],
  };
}

export const auth = betterAuth(createAuthOptions(authPool));
const oauthResourceActions = oauthProviderResourceClient(auth).getActions();
const authWithOAuthMetadataApi = auth as typeof auth & {
  api: {
    getOAuthServerConfig: (...args: unknown[]) => Promise<unknown>;
    getOpenIdConfig: (...args: unknown[]) => Promise<unknown>;
  };
};
const oauthServerMetadataHandler = oauthProviderAuthServerMetadata(authWithOAuthMetadataApi);
const openIdConfigMetadataHandler = oauthProviderOpenIdConfigMetadata(authWithOAuthMetadataApi);

export async function verifyOAuthAccessToken(
  token: string | undefined,
): ReturnType<typeof oauthResourceActions.verifyAccessToken> {
  return oauthResourceActions.verifyAccessToken(token, {
    verifyOptions: {
      audience: config.apiAudience,
      issuer: AUTH_ISSUER,
    },
    scopes: [MOBILE_API_SCOPE],
  });
}

function buildAuthUrl(request: FastifyRequest): URL {
  const forwardedHost = request.headers["x-forwarded-host"];
  const hostHeader = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost ?? request.headers.host ?? new URL(config.betterAuthUrl).host;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto ?? request.protocol ?? new URL(config.betterAuthUrl).protocol.replace(":", "");
  const path = request.raw.url ?? request.url;
  return new URL(path, `${protocol}://${hostHeader}`);
}

function buildAuthBody(body: unknown, contentType: string | null): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof URLSearchParams || body instanceof Buffer) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (contentType?.includes("application/x-www-form-urlencoded") && typeof body === "object") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) {
            params.append(key, String(item));
          }
        }
        continue;
      }
      params.append(key, String(value));
    }
    return params;
  }
  return JSON.stringify(body);
}

function buildForwardedHeaders(
  requestHeaders: FastifyRequest["headers"],
  overrideHeaders?: HeadersInit,
): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(requestHeaders)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
      continue;
    }
    headers.set(key, String(value));
  }

  if (overrideHeaders) {
    const extraHeaders = new Headers(overrideHeaders);
    extraHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  return headers;
}

function injectDefaultTokenResource(
  targetUrl: URL,
  method: string,
  headers: Headers,
  body: BodyInit | undefined,
): BodyInit | undefined {
  if (method.toUpperCase() !== "POST") {
    return body;
  }

  if (targetUrl.pathname !== `${AUTH_BASE_PATH}/oauth2/token`) {
    return body;
  }

  const contentType = headers.get("content-type") ?? "";
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return body;
  }

  let params: URLSearchParams | null = null;
  if (typeof body === "string") {
    params = new URLSearchParams(body);
  } else if (body instanceof URLSearchParams) {
    params = new URLSearchParams(body);
  }

  if (!params || params.has("resource")) {
    return body;
  }

  const clientId = params.get("client_id")?.trim();
  if (!clientId || !config.oauthTrustedClientIds.includes(clientId)) {
    return body;
  }

  params.set("resource", config.apiAudience);
  return params;
}

function toWebRequest(
  request: FastifyRequest,
  options: {
    path?: string;
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
  } = {},
): Request {
  const headers = buildForwardedHeaders(request.headers, options.headers);
  const url = buildAuthUrl(request);
  const targetUrl =
    options.path
      ? new URL(options.path, url.origin)
      : url;
  const body = injectDefaultTokenResource(
    targetUrl,
    options.method ?? request.method,
    headers,
    buildAuthBody(options.body ?? request.body, headers.get("content-type")),
  );
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Request(targetUrl, {
    method: options.method ?? request.method,
    headers,
    body,
  });
}

export async function dispatchAuthSubrequest(
  request: FastifyRequest,
  options: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
  },
): Promise<Response> {
  return auth.handler(toWebRequest(request, options));
}

export function applyAuthResponseHeaders(response: Response, reply: FastifyReply): void {
  const setCookies = "getSetCookie" in response.headers
    ? (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    : [];

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      return;
    }
    reply.header(key, value);
  });

  for (const cookie of setCookies) {
    reply.header("set-cookie", cookie);
  }
}

export async function sendAuthResponse(response: Response, reply: FastifyReply): Promise<void> {
  applyAuthResponseHeaders(response, reply);
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  reply.status(response.status);
  reply.send(body);
}

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  server.get(getOAuthAuthorizationServerMetadataPath(AUTH_BASE_PATH), async (request, reply) => {
    const response = await oauthServerMetadataHandler(toWebRequest(request));
    await sendAuthResponse(response, reply);
  });

  server.get(getOpenIdConfigurationPath(AUTH_BASE_PATH), async (request, reply) => {
    const response = await openIdConfigMetadataHandler(toWebRequest(request));
    await sendAuthResponse(response, reply);
  });

  server.get(getProtectedResourceMetadataPath(config.apiAudience), async (_request, reply) => {
    const metadata = await oauthResourceActions.getProtectedResourceMetadata({
      resource: config.apiAudience,
    });

    reply
      .header("Cache-Control", "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400")
      .header("Content-Type", "application/json")
      .send(metadata);
  });

  server.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      try {
        const response = await auth.handler(toWebRequest(request));
        await sendAuthResponse(response, reply);
      } catch (err) {
        server.log.error({ err }, "Failed to handle Better Auth request");
        reply.status(500).send({
          error: "internal_auth_error",
        });
      }
    },
  });
}
