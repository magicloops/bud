import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getNormalizedCurrentUser,
  UserProfileUpdateError,
  updateUserProfileUsername,
} from "../auth/session.js";

function serializeCurrentUser(currentUser: NonNullable<Awaited<ReturnType<typeof getNormalizedCurrentUser>>>) {
  const { session, profile, linkedProviders } = currentUser;
  const linkedProviderSet = new Set(linkedProviders);

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      email_verified: session.user.emailVerified,
      name: session.user.name,
      image: session.user.image ?? null,
    },
    session: {
      id: session.session.id,
      expires_at: session.session.expiresAt?.toISOString?.() ?? null,
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
        currentUser.session.user,
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
}
