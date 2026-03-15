import type { FastifyInstance } from "fastify";
import { getNormalizedCurrentUser } from "../auth/session.js";

export async function registerMeRoutes(server: FastifyInstance): Promise<void> {
  server.get("/api/me", async (request, reply) => {
    const currentUser = await getNormalizedCurrentUser(request);

    if (!currentUser) {
      return reply.status(401).send({
        error: "unauthorized",
      });
    }

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
  });
}
