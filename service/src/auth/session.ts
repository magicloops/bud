import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../db/client.js";
import { authAccountTable, userProfileTable } from "../db/schema.js";
import { auth } from "./auth.js";

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export type Viewer = {
  userId: string;
  sessionId: string;
  email: string;
};

function normalizeUsernameCandidate(input: string | null | undefined): string {
  const normalized = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);

  if (normalized.length >= 3) {
    return normalized;
  }

  return normalized ? `user-${normalized}`.slice(0, 32) : "user";
}

async function listLinkedProvidersForUser(userId: string): Promise<string[]> {
  const accounts = await db
    .select({
      providerId: authAccountTable.providerId,
    })
    .from(authAccountTable)
    .where(eq(authAccountTable.userId, userId));

  return [...new Set(accounts.map((account) => account.providerId))];
}

async function generateUsername(user: AuthSession["user"]): Promise<string> {
  const linkedProviders = await listLinkedProvidersForUser(user.id);
  const githubCandidate = linkedProviders.includes("github")
    ? normalizeUsernameCandidate(user.name)
    : "";
  const emailLocalPart = user.email?.split("@")[0] ?? "";
  const baseCandidate = githubCandidate || normalizeUsernameCandidate(emailLocalPart || user.name);

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? baseCandidate : `${baseCandidate}-${suffix + 1}`.slice(0, 32);
    const existing = await db.query.userProfileTable.findFirst({
      where: eq(userProfileTable.username, candidate),
    });

    if (!existing) {
      return candidate;
    }
  }

  return `user-${user.id.slice(0, 8).toLowerCase()}`;
}

export async function getAuthSession(request: FastifyRequest): Promise<AuthSession | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  return session ?? null;
}

export async function getOptionalViewer(request: FastifyRequest): Promise<Viewer | null> {
  const session = await getAuthSession(request);
  if (!session) {
    return null;
  }

  return {
    userId: session.user.id,
    sessionId: session.session.id,
    email: session.user.email,
  };
}

export async function requireViewer(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Viewer | null> {
  const viewer = await getOptionalViewer(request);
  if (viewer) {
    return viewer;
  }

  reply.status(401).send({ error: "unauthorized" });
  return null;
}

export async function ensureUserProfile(
  user: AuthSession["user"],
): Promise<typeof userProfileTable.$inferSelect> {
  const existing = await db.query.userProfileTable.findFirst({
    where: eq(userProfileTable.userId, user.id),
  });

  if (existing) {
    return existing;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const username = await generateUsername(user);

    await db
      .insert(userProfileTable)
      .values({
        userId: user.id,
        username,
      })
      .onConflictDoNothing();

    const created = await db.query.userProfileTable.findFirst({
      where: eq(userProfileTable.userId, user.id),
    });

    if (created) {
      return created;
    }
  }

  throw new Error(`Failed to bootstrap profile for user ${user.id}`);
}

export async function getNormalizedCurrentUser(
  request: FastifyRequest,
): Promise<{
  session: AuthSession;
  profile: typeof userProfileTable.$inferSelect;
  linkedProviders: string[];
} | null> {
  const session = await getAuthSession(request);
  if (!session) {
    return null;
  }

  const [profile, linkedProviders] = await Promise.all([
    ensureUserProfile(session.user),
    listLinkedProvidersForUser(session.user.id),
  ]);

  return {
    session,
    profile,
    linkedProviders,
  };
}
