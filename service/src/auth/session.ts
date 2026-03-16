import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { fromNodeHeaders } from "better-auth/node";
import { db } from "../db/client.js";
import {
  authAccountTable,
  budTable,
  terminalSessionTable,
  threadTable,
  userProfileTable,
} from "../db/schema.js";
import { auth } from "./auth.js";

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

export type Viewer = {
  userId: string;
  sessionId: string;
  email: string;
};

export type AuthorizedBud = typeof budTable.$inferSelect;
export type AuthorizedThread = typeof threadTable.$inferSelect;

const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;

export class UserProfileUpdateError extends Error {
  constructor(public readonly code: "invalid_username" | "username_taken") {
    super(code);
    this.name = "UserProfileUpdateError";
  }
}

function slugifyUsername(input: string | null | undefined): string {
  const normalized = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, USERNAME_MAX_LENGTH);

  return normalized;
}

function normalizeUsernameCandidate(input: string | null | undefined): string {
  const normalized = slugifyUsername(input);

  if (normalized.length >= USERNAME_MIN_LENGTH) {
    return normalized;
  }

  return normalized ? `user-${normalized}`.slice(0, USERNAME_MAX_LENGTH) : "user";
}

export function normalizeEditableUsername(input: string | null | undefined): string {
  const normalized = slugifyUsername(input);

  if (normalized.length < USERNAME_MIN_LENGTH) {
    throw new UserProfileUpdateError("invalid_username");
  }

  return normalized;
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
    const candidate =
      suffix === 0 ? baseCandidate : `${baseCandidate}-${suffix + 1}`.slice(0, USERNAME_MAX_LENGTH);
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

export async function updateUserProfileUsername(
  user: AuthSession["user"],
  input: string,
): Promise<typeof userProfileTable.$inferSelect> {
  const profile = await ensureUserProfile(user);
  const username = normalizeEditableUsername(input);

  if (profile.username === username) {
    return profile;
  }

  const existing = await db.query.userProfileTable.findFirst({
    where: eq(userProfileTable.username, username),
  });

  if (existing && existing.userId !== user.id) {
    throw new UserProfileUpdateError("username_taken");
  }

  const [updated] = await db
    .update(userProfileTable)
    .set({
      username,
      updatedAt: new Date(),
    })
    .where(eq(userProfileTable.userId, user.id))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update profile for user ${user.id}`);
  }

  return updated;
}

export async function getAuthorizedBud(
  viewer: Viewer,
  budId: string,
): Promise<AuthorizedBud | null> {
  return (
    (await db.query.budTable.findFirst({
      where: and(eq(budTable.budId, budId), eq(budTable.createdByUserId, viewer.userId)),
    })) ?? null
  );
}

export async function getAuthorizedThread(
  viewer: Viewer,
  threadId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<AuthorizedThread | null> {
  return (
    (await db.query.threadTable.findFirst({
      where: and(
        eq(threadTable.threadId, threadId),
        eq(threadTable.createdByUserId, viewer.userId),
        options.includeDeleted ? undefined : isNull(threadTable.deletedAt),
      ),
    })) ?? null
  );
}

export async function getAuthorizedSessionForThread(
  viewer: Viewer,
  threadId: string,
): Promise<{
  thread: AuthorizedThread;
  session: typeof terminalSessionTable.$inferSelect | null;
} | null> {
  const thread = await getAuthorizedThread(viewer, threadId);
  if (!thread) {
    return null;
  }

  const session =
    (await db.query.terminalSessionTable.findFirst({
      where: and(
        eq(terminalSessionTable.threadId, thread.threadId),
        eq(terminalSessionTable.createdByUserId, viewer.userId),
        isNull(terminalSessionTable.closedAt),
      ),
    })) ?? null;

  return { thread, session };
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
