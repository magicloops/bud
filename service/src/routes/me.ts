import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import { config } from "../config.js";
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
import { countUnseenThreads } from "../notifications/index.js";
import { db } from "../db/client.js";
import {
  authAccountTable,
  authSessionTable,
  pushEndpointTable,
  threadReadStateTable,
  threadTable,
} from "../db/schema.js";

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
  client_id: z.string().trim().min(1),
  client_secret: z.string().trim().min(1).optional(),
});
const pushEndpointParamsSchema = z.object({
  installation_id: z.string().trim().min(1),
});
const pushEndpointBodySchema = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm"]),
  provider_environment: z.enum(["sandbox", "production", "development"]).optional(),
  app_id: z.string().trim().min(1),
  token: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  alerts_agent_completed: z.boolean().optional(),
  alerts_human_input_requested: z.boolean().optional(),
  include_message_preview: z.boolean().optional(),
});

function isAllowedApnsTopic(appId: string): boolean {
  return config.apnsAllowedTopics.includes(appId);
}

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

  server.get("/api/me/notifications/summary", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const rows = await db
      .select({
        lastAttentionMessageId: threadTable.lastAttentionMessageId,
        lastAttentionMessageCreatedAt: threadTable.lastAttentionMessageCreatedAt,
        lastSeenMessageId: threadReadStateTable.lastSeenMessageId,
        lastSeenMessageCreatedAt: threadReadStateTable.lastSeenMessageCreatedAt,
      })
      .from(threadTable)
      .leftJoin(
        threadReadStateTable,
        and(
          eq(threadReadStateTable.threadId, threadTable.threadId),
          eq(threadReadStateTable.userId, currentUser.user.id),
        ),
      )
      .where(
        and(
          eq(threadTable.createdByUserId, currentUser.user.id),
          isNull(threadTable.deletedAt),
        ),
      );

    return {
      unseen_thread_count: countUnseenThreads(rows),
      updated_at: new Date().toISOString(),
    };
  });

  server.put("/api/me/push/endpoints/:installation_id", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const paramsResult = pushEndpointParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({ error: "invalid_installation_id" });
    }

    const bodyResult = pushEndpointBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    const now = new Date();
    const body = bodyResult.data;

    if (body.provider === "apns" && !isAllowedApnsTopic(body.app_id)) {
      return reply.status(400).send({
        error: "invalid_app_id",
        allowed_app_ids: config.apnsAllowedTopics,
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(pushEndpointTable)
        .where(
          or(
            and(
              eq(pushEndpointTable.provider, body.provider),
              eq(pushEndpointTable.token, body.token),
              or(
                ne(pushEndpointTable.userId, currentUser.user.id),
                ne(pushEndpointTable.installationId, paramsResult.data.installation_id),
              ),
            ),
            and(
              eq(pushEndpointTable.installationId, paramsResult.data.installation_id),
              ne(pushEndpointTable.userId, currentUser.user.id),
            ),
          ),
        );

      await tx
        .insert(pushEndpointTable)
        .values({
          userId: currentUser.user.id,
          installationId: paramsResult.data.installation_id,
          platform: body.platform,
          provider: body.provider,
          providerEnvironment: body.provider_environment ?? null,
          appId: body.app_id,
          token: body.token,
          enabled: body.enabled ?? true,
          alertsAgentCompleted: body.alerts_agent_completed ?? true,
          alertsHumanInputRequested: body.alerts_human_input_requested ?? true,
          includeMessagePreview: body.include_message_preview ?? true,
          lastRegisteredAt: now,
          lastSeenAt: now,
          createdByUserId: currentUser.user.id,
        })
        .onConflictDoUpdate({
          target: [pushEndpointTable.userId, pushEndpointTable.installationId],
          set: {
            platform: body.platform,
            provider: body.provider,
            providerEnvironment: body.provider_environment ?? null,
            appId: body.app_id,
            token: body.token,
            enabled: body.enabled ?? true,
            alertsAgentCompleted: body.alerts_agent_completed ?? true,
            alertsHumanInputRequested: body.alerts_human_input_requested ?? true,
            includeMessagePreview: body.include_message_preview ?? true,
            invalidatedAt: null,
            lastRegisteredAt: now,
            lastSeenAt: now,
            updatedAt: now,
          },
        });
    });

    return {
      installation_id: paramsResult.data.installation_id,
      status: "registered",
    };
  });

  server.delete("/api/me/push/endpoints/:installation_id", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);
    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

    const paramsResult = pushEndpointParamsSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.status(400).send({ error: "invalid_installation_id" });
    }

    const [deleted] = await db
      .delete(pushEndpointTable)
      .where(
        and(
          eq(pushEndpointTable.userId, currentUser.user.id),
          eq(pushEndpointTable.installationId, paramsResult.data.installation_id),
        ),
      )
      .returning({ installationId: pushEndpointTable.installationId });

    if (!deleted) {
      return reply.status(404).send({ error: "push_endpoint_not_found" });
    }

    return {
      installation_id: deleted.installationId,
      status: "deleted",
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
