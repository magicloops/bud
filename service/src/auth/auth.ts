import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { betterAuth } from "better-auth";
import { config } from "../config.js";
import { Pool } from "pg";

const authHandlerPoolOptions = {
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

export const auth = betterAuth({
  database: authPool,
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  trustedOrigins: config.betterAuthTrustedOrigins,
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
});

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

function toWebRequest(request: FastifyRequest): Request {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
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

  const body = buildAuthBody(request.body, headers.get("content-type"));
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Request(buildAuthUrl(request), {
    method: request.method,
    headers,
    body,
  });
}

async function sendAuthResponse(response: Response, reply: FastifyReply): Promise<void> {
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

  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  reply.status(response.status);
  reply.send(body);
}

export async function registerAuthRoutes(server: FastifyInstance): Promise<void> {
  server.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
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
