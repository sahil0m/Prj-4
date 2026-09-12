import { Types } from 'mongoose';
import { User, Deck, Session, Response, Participant } from '../models/index.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';
import { pingDb } from '../lib/db.js';
import { availableProviders, isAiConfigured } from './ai/providers.js';

/**
 * The admin view.
 *
 * Deliberately small. An admin of this system needs to answer four
 * questions — who is using it, is anyone abusing it, is the free AI quota
 * about to run out, and is anything broken — and every screen here exists
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

export async function overview(): Promise<AdminOverview> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Counted in parallel: these are independent, and an admin page that takes
  // a second to load gets reloaded impatiently, multiplying the cost.
  const [
    totalUsers,
    activeUsers,
    newUsers,
    suspendedUsers,
    decks,
    totalSessions,
    liveSessions,
    responses,
    aiToday,
    database,
  ] = await Promise.all([
    User.countDocuments({ deletedAt: null }),
    User.countDocuments({ deletedAt: null, lastSeenAt: { $gte: weekAgo } }),
    User.countDocuments({ deletedAt: null, createdAt: { $gte: weekAgo } }),
    User.countDocuments({ deletedAt: null, suspendedAt: { $ne: null } }),
    Deck.countDocuments({ deletedAt: null }),
    Session.countDocuments({}),
    Session.countDocuments({ state: { $in: ['live', 'paused'] } }),
    Response.countDocuments({ deletedAt: null }),
    sumAiRequestsToday(),
    pingDb(),
  ]);

  return {
    users: {
      total: totalUsers,
      active7d: activeUsers,
      newThisWeek: newUsers,
      suspended: suspendedUsers,
    },
    content: { decks, sessions: totalSessions, liveSessions, responses },
    ai: {
      configured: isAiConfigured(),
      providers: availableProviders(),
      requestsToday: aiToday,
    },
    health: { database, uptimeSeconds: Math.round(process.uptime()) },
  };
}

/** Total AI calls today, across everyone sharing the free quota. */
async function sumAiRequestsToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const result = await User.aggregate<{ total: number }>([
    { $match: { aiRequestsResetAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$aiRequestsToday' } } },
  ]);

  return result[0]?.total ?? 0;
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

export async function listUsers(options: {
  search?: string;
  suspendedOnly?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ users: AdminUser[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const filter: Record<string, unknown> = { deletedAt: null };

  if (options.suspendedOnly) filter.suspendedAt = { $ne: null };

  const search = options.search?.trim();
  if (search) {
    // Escaped, or a search for ".*" would match every user.
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { email: { $regex: safe, $options: 'i' } },
      { name: { $regex: safe, $options: 'i' } },
    ];
  }

  // Keyset pagination on _id: a skip/limit page shifts under you as rows are
  // added, showing the same user twice or missing one entirely.
  if (options.cursor && Types.ObjectId.isValid(options.cursor)) {
    filter._id = { $lt: new Types.ObjectId(options.cursor) };
  }

  const rows = await User.find(filter)
    .select(
      'email name role identities emailVerifiedAt suspendedAt suspendedReason aiRequestsToday createdAt lastSeenAt',
    )
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Counts for the whole page in two queries rather than two per user.
  const ids = page.map((user) => user._id);

  const [deckCounts, sessionCounts] = await Promise.all([
    Deck.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ownerId: { $in: ids }, deletedAt: null } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]),
    Session.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ownerId: { $in: ids } } },
      { $group: { _id: '$ownerId', count: { $sum: 1 } } },
    ]),
  ]);

  const decksBy = new Map(deckCounts.map((row) => [row._id.toString(), row.count]));
  const sessionsBy = new Map(sessionCounts.map((row) => [row._id.toString(), row.count]));

  return {
    users: page.map((user) => {
      const id = user._id.toString();
      return {
        id,
        email: user.email,
        name: user.name,
        role: user.role,
        providers: user.identities.map((identity) => identity.provider),
        emailVerified: user.emailVerifiedAt !== null,
        suspended: user.suspendedAt !== null,
        suspendedReason: user.suspendedReason,
        deckCount: decksBy.get(id) ?? 0,
        sessionCount: sessionsBy.get(id) ?? 0,
        aiRequestsToday: user.aiRequestsToday,
        createdAt: user.createdAt,
        // Mongoose types a null-defaulted path as possibly undefined; the
        // wire format has only null.
        lastSeenAt: user.lastSeenAt ?? null,
      };
    }),
    nextCursor: hasMore ? (page[page.length - 1]?._id.toString() ?? null) : null,
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

  user.suspendedAt = suspended ? new Date() : null;
  user.suspendedReason = suspended ? reason.slice(0, 300) : '';
  if (suspended) user.tokenVersion += 1;

  await user.save();

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
  user.role = role;
  await user.save();

  logger.warn({ actorId, userId, role }, 'Role changed');
}

async function findUser(userId: string) {
  if (!Types.ObjectId.isValid(userId)) {
    throw new HttpError(404, 'That account was not found.', 'user_not_found');
  }

  const user = await User.findOne({ _id: userId, deletedAt: null });
  if (!user) throw new HttpError(404, 'That account was not found.', 'user_not_found');

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
  const sessions = await Session.find({ state: { $in: ['live', 'paused'] } })
    .select('title joinCode ownerId state stats startedAt')
    .sort({ startedAt: -1 })
    .limit(100)
    .lean();

  if (sessions.length === 0) return [];

  const owners = await User.find({ _id: { $in: sessions.map((s) => s.ownerId) } })
    .select('name email')
    .lean();

  const ownerBy = new Map(owners.map((owner) => [owner._id.toString(), owner]));

  // Counted live rather than read from stats: the cached counter can drift
  // if a process died mid-session, and an admin screen showing a wrong
  // number is worse than one that takes a moment longer.
  const counts = await Promise.all(
    sessions.map(async (session) => ({
      id: session._id.toString(),
      participants: await Participant.countDocuments({ sessionId: session._id, blockedAt: null }),
      responses: await Response.countDocuments({ sessionId: session._id, deletedAt: null }),
    })),
  );

  const countBy = new Map(counts.map((row) => [row.id, row]));

  return sessions.map((session) => {
    const id = session._id.toString();
    const owner = ownerBy.get((session.ownerId as Types.ObjectId).toString());
    const count = countBy.get(id);

    return {
      id,
      title: session.title,
      joinCode: session.joinCode,
      ownerName: owner?.name ?? 'Unknown',
      ownerEmail: owner?.email ?? '',
      state: session.state,
      participants: count?.participants ?? 0,
      responses: count?.responses ?? 0,
      startedAt: session.startedAt,
    };
  });
}
