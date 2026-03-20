import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import {
  AUTH_BASE_PATH,
  applyAuthResponseHeaders,
  auth,
  dispatchAuthSubrequest,
} from "../auth/auth.js";
import {
  getNormalizedCurrentUser,
  type NormalizedCurrentUser,
  UserProfileUpdateError,
  updateUserProfileUsername,
} from "../auth/session.js";
import { db } from "../db/client.js";
import { authAccountTable, authSessionTable } from "../db/schema.js";

function serializeCurrentUser(currentUser: NormalizedCurrentUser) {
  const { user, session, profile, linkedProviders, viewer } = currentUser;
  const linkedProviderSet = new Set(linkedProviders);

  return {
    auth_type: viewer.authType,
    user: {
      id: user.id,
      email: user.email,
      email_verified: user.emailVerified,
      name: user.name,
      image: user.image ?? null,
    },
    session: {
      id: session.id,
      expires_at: session.expiresAt?.toISOString?.() ?? null,
    },
    profile: {
      username: profile.username,
      created_at: profile.createdAt.toISOString(),
      updated_at: profile.updatedAt.toISOString(),
    },
    linked_accounts: {
      github: linkedProviderSet.has("github"),
      google: linkedProviderSet.has("google"),
    },
    linked_providers: linkedProviders,
  };
}

const updateProfileBodySchema = z.object({
  username: z.string().trim().min(1).max(128),
});

const linkedAccountProviderSchema = z.enum(["github", "google"]);
const accountLinkStartParamsSchema = z.object({
  provider: linkedAccountProviderSchema,
});
const accountLinkStartBodySchema = z.object({
  callback_url: z.string().url(),
  error_callback_url: z.string().url().optional(),
  scopes: z.array(z.string().trim().min(1)).min(1).max(32).optional(),
});
const oauthRevokeBodySchema = z.object({
  token: z.string().trim().min(1),
  token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
});

function splitAccountScopes(scope: string | null): string[] {
  return (scope ?? "")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function serializeLinkedAccount(account: typeof authAccountTable.$inferSelect) {
  return {
    id: account.id,
    provider: account.providerId,
    account_id: account.accountId,
    scopes: splitAccountScopes(account.scope ?? null),
    has_access_token: Boolean(account.accessToken),
    has_refresh_token: Boolean(account.refreshToken),
    access_token_expires_at: account.accessTokenExpiresAt?.toISOString?.() ?? null,
    refresh_token_expires_at: account.refreshTokenExpiresAt?.toISOString?.() ?? null,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

function serializeBrowserSession(
  session: typeof authSessionTable.$inferSelect,
  currentSessionId: string | null,
) {
  return {
    id: session.id,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
    ip_address: session.ipAddress ?? null,
    user_agent: session.userAgent ?? null,
    is_current: currentSessionId === session.id,
    is_active: session.expiresAt.getTime() > Date.now(),
  };
}

async function sendNormalizedAuthFailure(response: Response, reply: FastifyReply): Promise<void> {
  applyAuthResponseHeaders(response, reply);

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  reply.status(response.status).send(
    typeof payload === "object" && payload !== null
      ? payload
      : {
          error: "auth_request_failed",
          detail: payload || null,
        },
  );
}

export async function registerMeRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/me", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);

    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    return serializeCurrentUser(currentUser);
  });

  server.get("/api/me/accounts", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const accounts = await db.query.authAccountTable.findMany({
      where: eq(authAccountTable.userId, currentUser.user.id),
      orderBy: (table, { desc: orderDesc }) => [orderDesc(table.updatedAt), orderDesc(table.createdAt)],
    });

    return {
      auth_type: currentUser.viewer.authType,
      accounts: accounts.map(serializeLinkedAccount),
    };
  });

  server.get("/api/me/sessions", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const sessions = await db.query.authSessionTable.findMany({
      where: eq(authSessionTable.userId, currentUser.user.id),
      orderBy: (table, { desc: orderDesc }) => [orderDesc(table.updatedAt), orderDesc(table.createdAt)],
    });

    return {
      auth_type: currentUser.viewer.authType,
      current_session_id: currentUser.session.id,
      sessions: sessions.map((session) =>
        serializeBrowserSession(session, currentUser.session.id),
      ),
    };
  });

  server.post("/api/me/account-links/:provider/start", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const paramsResult = accountLinkStartParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({
        error: "invalid_provider",
      });
    }

    const bodyResult = accountLinkStartBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_body",
      });
    }

    const { provider } = paramsResult.data;
    const { callback_url, error_callback_url, scopes } = bodyResult.data;

    const result =
      currentUser.viewer.authType === "cookie"
        ? await auth.api.linkSocialAccount({
            headers: fromNodeHeaders(request.headers),
            body: {
              provider,
              callbackURL: callback_url,
              errorCallbackURL: error_callback_url,
              scopes,
              disableRedirect: true,
            },
          })
        : await auth.api.signInSocial({
            body: {
              provider,
              callbackURL: callback_url,
              errorCallbackURL: error_callback_url,
              scopes,
              disableRedirect: true,
              requestSignUp: false,
            },
          });

    if (!result || !("url" in result) || !result.url) {
      return reply.status(409).send({
        error: "account_link_unavailable",
      });
    }

    return {
      auth_type: currentUser.viewer.authType,
      provider,
      strategy:
        currentUser.viewer.authType === "cookie" ? "session_link" : "implicit_sign_in",
      same_email_required: currentUser.viewer.authType === "bearer",
      authorization_url: result.url,
    };
  });

  server.patch("/api/me/profile", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const bodyResult = updateProfileBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_body",
      });
    }

    try {
      const profile = await updateUserProfileUsername(
        currentUser.user,
        bodyResult.data.username,
      );

      return serializeCurrentUser({
        ...currentUser,
        profile,
      });
    } catch (error) {
      if (error instanceof UserProfileUpdateError) {
        const status = error.code === "username_taken" ? 409 : 400;
        return reply.status(status).send({
          error: error.code,
        });
      }

      throw error;
    }
  });

  server.post("/api/me/logout", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    if (currentUser.viewer.authType !== "cookie") {
      return reply.status(400).send({
        error: "cookie_session_required",
      });
    }

    const authResponse = await dispatchAuthSubrequest(request, {
      path: `${AUTH_BASE_PATH}/sign-out`,
      method: "POST",
    });

    if (!authResponse.ok) {
      return sendNormalizedAuthFailure(authResponse, reply);
    }

    applyAuthResponseHeaders(authResponse, reply);
    return reply.status(200).send({
      auth_type: currentUser.viewer.authType,
      status: "signed_out",
    });
  });

  server.post("/api/me/oauth/revoke", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const bodyResult = oauthRevokeBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({
        error: "invalid_body",
      });
    }

    const authResponse = await dispatchAuthSubrequest(request, {
      path: `${AUTH_BASE_PATH}/oauth2/revoke`,
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: {
        token: bodyResult.data.token,
        token_type_hint: bodyResult.data.token_type_hint,
        client_id: bodyResult.data.client_id,
        client_secret: bodyResult.data.client_secret,
      },
    });

    if (!authResponse.ok) {
      return sendNormalizedAuthFailure(authResponse, reply);
    }

    return {
      auth_type: currentUser.viewer.authType,
      status: "revoked",
    };
  });
}
