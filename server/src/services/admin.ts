import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../lib/db.js';
import { isId } from '../db/ids.js';
import { users, userIdentities, decks, sessions, responses, type User } from '../db/schema.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';
import { pingDb } from '../lib/db.js';
import { availableProviders, isAiConfigured } from './ai/providers.js';

/**
 * The admin view.
 *
 * Deliberately small. An admin of this system needs to answer four
 * questions -- who is using it, is anyone abusing it, is the free AI quota
 * about to run out, and is anything broken -- and every screen here exists
 * to answer one of them. Screens nobody opens are a maintenance cost, not a
 * feature.
 */

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

export interface AdminOverview {
  users: { total: number; active7d: number; newThisWeek: number; suspended: number };
  content: { decks: number; sessions: number; liveSessions: number; responses: number };
  ai: { configured: boolean; providers: string[]; requestsToday: number };
  health: { database: { ok: boolean; latencyMs: number }; uptimeSeconds: number };
}

/** A count as a plain number; Postgres returns count(*) as a bigint. */
const countOf = sql<number>`count(*)::int`;

export async function overview(): Promise<AdminOverview> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Filtered aggregates: every user figure in one pass over the table rather
  // than four separate counts, and likewise for sessions.
  const [userStats, deckStats, sessionStats, responseStats, database] = await Promise.all([
    db
      .select({
        total: countOf,
        active7d: sql<number>`count(*) FILTER (WHERE ${users.lastSeenAt} >= ${weekAgo})::int`,
        newThisWeek: sql<number>`count(*) FILTER (WHERE ${users.createdAt} >= ${weekAgo})::int`,
        suspended: sql<number>`count(*) FILTER (WHERE ${users.suspendedAt} IS NOT NULL)::int`,
        aiToday: sql<number>`COALESCE(sum(${users.aiRequestsToday}) FILTER (WHERE ${users.aiRequestsResetAt} >= ${startOfDay}), 0)::int`,
      })
      .from(users)
      .where(isNull(users.deletedAt)),
    db.select({ total: countOf }).from(decks).where(isNull(decks.deletedAt)),
    db
      .select({
        total: countOf,
        live: sql<number>`count(*) FILTER (WHERE ${sessions.state} IN ('live', 'paused'))::int`,
      })
      .from(sessions),
    db.select({ total: countOf }).from(responses).where(isNull(responses.deletedAt)),
    pingDb(),
  ]);

  const u = userStats[0];
  const s = sessionStats[0];

  return {
    users: {
      total: u?.total ?? 0,
      active7d: u?.active7d ?? 0,
      newThisWeek: u?.newThisWeek ?? 0,
      suspended: u?.suspended ?? 0,
    },
    content: {
      decks: deckStats[0]?.total ?? 0,
      sessions: s?.total ?? 0,
      liveSessions: s?.live ?? 0,
      responses: responseStats[0]?.total ?? 0,
    },
    ai: {
      configured: isAiConfigured(),
      providers: availableProviders(),
      requestsToday: u?.aiToday ?? 0,
    },
    health: { database, uptimeSeconds: Math.round(process.uptime()) },
  };
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  providers: string[];
  emailVerified: boolean;
  suspended: boolean;
  suspendedReason: string;
  deckCount: number;
  sessionCount: number;
  aiRequestsToday: number;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/** Escapes LIKE's wildcards, so searching for "a_b" means those characters. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listUsers(options: {
  search?: string;
  suspendedOnly?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ users: AdminUser[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const conditions: SQL[] = [isNull(users.deletedAt)];

  if (options.suspendedOnly) conditions.push(isNotNull(users.suspendedAt));

  const search = options.search?.trim();
  if (search) {
    const pattern = `%${likeLiteral(search)}%`;
    const match = or(ilike(users.email, pattern), ilike(users.name, pattern));
    if (match) conditions.push(match);
  }

  // Keyset pagination on id, which sorts by creation time: an offset page
  // shifts under you as rows are added, showing the same user twice or
  // missing one entirely.
  if (options.cursor && isId(options.cursor)) conditions.push(lt(users.id, options.cursor));

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      emailVerifiedAt: users.emailVerifiedAt,
      suspendedAt: users.suspendedAt,
      suspendedReason: users.suspendedReason,
      aiRequestsToday: users.aiRequestsToday,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .where(and(...conditions))
    .orderBy(desc(users.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((user) => user.id);

  if (ids.length === 0) return { users: [], nextCursor: null };

  // Everything else for the whole page in three queries, not three per user.
  const [deckCounts, sessionCounts, identities] = await Promise.all([
    db
      .select({ ownerId: decks.ownerId, value: count() })
      .from(decks)
      .where(and(inArray(decks.ownerId, ids), isNull(decks.deletedAt)))
      .groupBy(decks.ownerId),
    db
      .select({ ownerId: sessions.ownerId, value: count() })
      .from(sessions)
      .where(inArray(sessions.ownerId, ids))
      .groupBy(sessions.ownerId),
    db
      .select({ userId: userIdentities.userId, provider: userIdentities.provider })
      .from(userIdentities)
      .where(inArray(userIdentities.userId, ids)),
  ]);

  const decksBy = new Map(deckCounts.map((row) => [row.ownerId, row.value]));
  const sessionsBy = new Map(sessionCounts.map((row) => [row.ownerId, row.value]));

  const providersBy = new Map<string, string[]>();
  for (const identity of identities) {
    providersBy.set(identity.userId, [
      ...(providersBy.get(identity.userId) ?? []),
      identity.provider,
    ]);
  }

  return {
    users: page.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      providers: providersBy.get(user.id) ?? [],
      emailVerified: user.emailVerifiedAt !== null,
      suspended: user.suspendedAt !== null,
      suspendedReason: user.suspendedReason,
      deckCount: decksBy.get(user.id) ?? 0,
      sessionCount: sessionsBy.get(user.id) ?? 0,
      aiRequestsToday: user.aiRequestsToday,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Moderation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Suspends or restores an account.
 *
 * Bumping tokenVersion is what makes a suspension immediate: every access
 * token issued before now stops being accepted on the next request, rather
 * than the user continuing for up to the token's remaining lifetime.
 */
export async function setSuspended(
  actorId: string,
  userId: string,
  suspended: boolean,
  reason: string,
): Promise<void> {
  if (actorId === userId) {
    throw new HttpError(422, 'You cannot suspend your own account.', 'cannot_suspend_self');
  }

  const user = await findUser(userId);

  if (suspended && user.role === 'admin') {
    throw new HttpError(
      422,
      'Remove the admin role before suspending this account.',
      'cannot_suspend_admin',
    );
  }

  await db
    .update(users)
    .set({
      suspendedAt: suspended ? new Date() : null,
      suspendedReason: suspended ? reason.slice(0, 300) : '',
      ...(suspended ? { tokenVersion: sql`${users.tokenVersion} + 1` } : {}),
    })
    .where(eq(users.id, user.id));

  logger.warn(
    { actorId, userId, suspended, reason },
    suspended ? 'Account suspended' : 'Account restored',
  );
}

/**
 * Changes a user's role.
 *
 * An admin cannot demote themselves: doing so by accident would leave the
 * system with no administrator and no way back in.
 */
export async function setRole(
  actorId: string,
  userId: string,
  role: 'user' | 'admin',
): Promise<void> {
  if (actorId === userId && role === 'user') {
    throw new HttpError(422, 'You cannot remove your own admin access.', 'cannot_demote_self');
  }

  const user = await findUser(userId);
  await db.update(users).set({ role }).where(eq(users.id, user.id));

  logger.warn({ actorId, userId, role }, 'Role changed');
}

async function findUser(userId: string): Promise<Pick<User, 'id' | 'role'>> {
  const notFound = () => new HttpError(404, 'That account was not found.', 'user_not_found');
  if (!isId(userId)) throw notFound();

  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));

  if (!user) throw notFound();
  return user;
}

/* ------------------------------------------------------------------ */
/* Live sessions                                                       */
/* ------------------------------------------------------------------ */

export interface AdminSession {
  id: string;
  title: string;
  joinCode: string;
  ownerName: string;
  ownerEmail: string;
  state: string;
  participants: number;
  responses: number;
  startedAt: Date;
}

/** What is running right now, so an admin can see load as it happens. */
export async function liveSessions(): Promise<AdminSession[]> {
  /*
   * Counted live rather than read from the cached counters, which can drift
   * if a process died mid-session -- and an admin screen showing a wrong
   * number is worse than one that takes a moment longer. One query for the
   * whole list, where the old version made two per session.
   */
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      joinCode: sessions.joinCode,
      state: sessions.state,
      startedAt: sessions.startedAt,
      ownerName: users.name,
      ownerEmail: users.email,
      participants: sql<number>`(
        SELECT count(*)::int FROM participants p
        WHERE p.session_id = ${sessions.id} AND p.blocked_at IS NULL
      )`,
      responses: sql<number>`(
        SELECT count(*)::int FROM responses r
        WHERE r.session_id = ${sessions.id} AND r.deleted_at IS NULL
      )`,
    })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.ownerId))
    .where(inArray(sessions.state, ['live', 'paused']))
    .orderBy(desc(sessions.startedAt))
    .limit(100);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    joinCode: row.joinCode,
    ownerName: row.ownerName ?? 'Unknown',
    ownerEmail: row.ownerEmail ?? '',
    state: row.state,
    participants: row.participants,
    responses: row.responses,
    startedAt: row.startedAt,
  }));
}
