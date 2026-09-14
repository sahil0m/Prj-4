import argon2 from 'argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, isUniqueViolation, type Executor } from '../lib/db.js';
import { newId, isId } from '../db/ids.js';
import {
  users,
  userIdentities,
  refreshTokens,
  type User,
  type RevokeReason,
} from '../db/schema.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateTokenFamily,
  REFRESH_TOKEN_TTL_MS,
} from '../lib/tokens.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../app.js';

/**
 * Authentication logic, deliberately free of Express types so it can be
 * tested directly and reused from the socket layer.
 */

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

/**
 * A user as the rest of the server sees one.
 *
 * The password hash is not on this type at all. MongoDB hid it with a
 * select:false flag, which meant any query that forgot to ask for it read
 * it as absent -- the root of an earlier bug where accounts with passwords
 * were reported as having none. Here the hash is only ever loaded by the
 * two functions that verify it, and cannot leave this file.
 */
export type Account = Omit<User, 'passwordHash'> & { providers: string[] };

/** Every column except the hash, for queries that return an account. */
const accountColumns = {
  id: users.id,
  email: users.email,
  hasPassword: users.hasPassword,
  name: users.name,
  avatarUrl: users.avatarUrl,
  locale: users.locale,
  emailVerifiedAt: users.emailVerifiedAt,
  tokenVersion: users.tokenVersion,
  role: users.role,
  suspendedAt: users.suspendedAt,
  suspendedReason: users.suspendedReason,
  aiRequestsToday: users.aiRequestsToday,
  aiRequestsResetAt: users.aiRequestsResetAt,
  lastSeenAt: users.lastSeenAt,
  deletedAt: users.deletedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

async function providersOf(executor: Executor, userId: string): Promise<string[]> {
  const rows = await executor
    .select({ provider: userIdentities.provider })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(userIdentities.linkedAt);

  return rows.map((row) => row.provider);
}

/** An account by id, or null if it does not exist or was deleted. */
export async function getAccount(userId: string, executor: Executor = db): Promise<Account | null> {
  if (!isId(userId)) return null;

  const [row] = await executor
    .select(accountColumns)
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));

  if (!row) return null;
  return { ...row, providers: await providersOf(executor, row.id) };
}

/** Records that the account was just used, and returns it as it now stands. */
async function touch(executor: Executor, userId: string): Promise<Account> {
  const [row] = await executor
    .update(users)
    .set({ lastSeenAt: new Date() })
    .where(eq(users.id, userId))
    .returning(accountColumns);

  if (!row) throw new HttpError(401, 'Please sign in again.', 'user_not_found');
  return { ...row, providers: await providersOf(executor, row.id) };
}

/* ------------------------------------------------------------------ */
/* Password hashing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Argon2id, the current recommendation for password storage. Parameters
 * follow OWASP guidance: 19MB of memory and two passes, which costs roughly
 * 50ms on server hardware and is deliberately expensive to run in bulk on a
 * GPU.
 */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed hash must read as "wrong password", never as a crash.
    return false;
  }
}

/**
 * A hash of a fixed dummy password, used to keep the timing of a failed
 * login the same whether or not the account exists. Without this, response
 * time alone reveals which email addresses are registered.
 */
let decoyHash: string | null = null;
async function getDecoyHash(): Promise<string> {
  decoyHash ??= await hashPassword('decoy-password-for-constant-time-login');
  return decoyHash;
}

/* ------------------------------------------------------------------ */
/* Session issuing                                                     */
/* ------------------------------------------------------------------ */

export interface DeviceInfo {
  userAgent: string;
  ip: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** IPs are stored only as a salted hash, never in plain text. */
function hashIp(ip: string): string {
  return createHash('sha256').update(`pulse:${ip}`).digest('hex').slice(0, 32);
}

function claimsFor(user: Account) {
  return {
    sub: user.id,
    tv: user.tokenVersion,
    email: user.email,
    name: user.name,
  };
}

async function issueSession(
  executor: Executor,
  user: Account,
  device: DeviceInfo,
  family = generateTokenFamily(),
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await executor.insert(refreshTokens).values({
    id: newId(),
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    family,
    expiresAt,
    userAgent: device.userAgent.slice(0, 300),
    ipHash: hashIp(device.ip),
  });

  return { accessToken: signAccessToken(claimsFor(user)), refreshToken, expiresAt };
}

/** Revokes every live token matching a condition, with a reason for the audit trail. */
function revokeWhere(executor: Executor, condition: ReturnType<typeof and>, reason: RevokeReason) {
  return executor
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(condition, isNull(refreshTokens.revokedAt)));
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export async function register(
  input: RegisterInput,
  device: DeviceInfo,
): Promise<{ user: Account; session: IssuedSession }> {
  const email = input.email.trim().toLowerCase();

  const [existing] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email));

  if (existing) {
    // The account exists but has only a social login. Setting a password
    // here would let anyone who guesses the email take it over, so refuse
    // and point them at the provider they already used.
    if (!existing.passwordHash) {
      throw new HttpError(
        409,
        'That email is already linked to a Google account. Continue with Google instead.',
        'use_social_login',
      );
    }
    throw new HttpError(409, 'An account with that email already exists.', 'email_taken');
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({ id: newId(), email, passwordHash, name: input.name.trim() })
        .returning(accountColumns);

      if (!created) throw new Error('Account insert returned no row');

      const user: Account = { ...created, providers: [] };
      logger.info({ userId: user.id }, 'Account created');

      return { user, session: await issueSession(tx, user, device) };
    });
  } catch (err) {
    // Two sign-ups for the same address racing past the check above: the
    // unique index lets exactly one through, and the other gets the same
    // answer it would have got a moment later.
    if (isUniqueViolation(err, 'users_email_key')) {
      throw new HttpError(409, 'An account with that email already exists.', 'email_taken');
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

/**
 * Refuses a suspended account.
 *
 * Every authenticated request already checks this, so a suspended user was
 * blocked -- but only after signing in successfully, landing on the
 * dashboard and watching every request fail. That reads as a broken
 * product rather than a decision someone made, and gives no reason.
 *
 * Called after credentials are verified, never before: refusing early
 * would tell anyone who asked which addresses have suspended accounts.
 */
function assertNotSuspended(user: Pick<User, 'suspendedAt' | 'suspendedReason'>): void {
  if (!user.suspendedAt) return;

  throw new HttpError(
    403,
    user.suspendedReason || 'This account has been suspended.',
    'account_suspended',
  );
}

export async function login(
  email: string,
  password: string,
  device: DeviceInfo,
): Promise<{ user: Account; session: IssuedSession }> {
  const normalised = email.trim().toLowerCase();

  const [found] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      suspendedAt: users.suspendedAt,
      suspendedReason: users.suspendedReason,
    })
    .from(users)
    .where(and(eq(users.email, normalised), isNull(users.deletedAt)));

  // Always run a verification, even with no user, so the response time does
  // not reveal whether the account exists.
  const hash = found?.passwordHash ?? (await getDecoyHash());
  const ok = await verifyPassword(hash, password);

  if (!found || !ok || !found.passwordHash) {
    throw new HttpError(401, 'That email or password is not right.', 'invalid_credentials');
  }

  assertNotSuspended(found);

  return db.transaction(async (tx) => {
    const user = await touch(tx, found.id);
    return { user, session: await issueSession(tx, user, device) };
  });
}

/* ------------------------------------------------------------------ */
/* Refresh, with rotation and reuse detection                          */
/* ------------------------------------------------------------------ */

export async function refresh(
  presentedToken: string,
  device: DeviceInfo,
): Promise<{ user: Account; session: IssuedSession }> {
  const tokenHash = hashRefreshToken(presentedToken);

  return db
    .transaction(async (tx) => {
      /*
       * Consume the token in one statement.
       *
       * Reading it, checking it was unused, then marking it used is a race:
       * two requests presenting the same token at the same moment could both
       * see it unused and both be issued a new one. The conditional update
       * lets exactly one of them match; the other finds nothing to consume
       * and falls through to the checks below.
       */
      const [consumed] = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date(), revokedAt: new Date(), revokedReason: 'rotated' })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.usedAt),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: refreshTokens.userId, family: refreshTokens.family });

      if (!consumed) {
        const [record] = await tx
          .select({
            userId: refreshTokens.userId,
            family: refreshTokens.family,
            usedAt: refreshTokens.usedAt,
            revokedAt: refreshTokens.revokedAt,
          })
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, tokenHash));

        if (!record) {
          throw new HttpError(401, 'Please sign in again.', 'invalid_refresh_token');
        }

        /*
         * The token exists but has already been exchanged. Two parties
         * therefore hold it, and we cannot tell which is legitimate. Revoke
         * the whole family so both are forced to re-authenticate -- the
         * attacker loses access, and the real user is inconvenienced once
         * rather than silently compromised.
         *
         * Committed by returning rather than throwing: an exception would roll
         * the revocation back along with everything else in the transaction.
         */
        if (record.usedAt || record.revokedAt) {
          await revokeWhere(tx, eq(refreshTokens.family, record.family), 'reuse_detected');

          logger.warn(
            { userId: record.userId, family: record.family },
            'Refresh token reuse detected; token family revoked',
          );
          return null;
        }

        throw new HttpError(401, 'Your session expired. Please sign in again.', 'refresh_expired');
      }

      const account = await getAccount(consumed.userId, tx);
      if (!account) {
        throw new HttpError(401, 'Please sign in again.', 'user_not_found');
      }

      const user = await touch(tx, account.id);
      return { user, session: await issueSession(tx, user, device, consumed.family) };
    })
    .then((result) => {
      if (!result) throw new HttpError(401, 'Please sign in again.', 'token_reuse_detected');
      return result;
    });
}

/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */

export async function logout(presentedToken: string): Promise<void> {
  const [record] = await db
    .select({ family: refreshTokens.family })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(presentedToken)));

  if (!record) return; // Already gone. Nothing to do, and nothing to reveal.

  await revokeWhere(db, eq(refreshTokens.family, record.family), 'logout');
}

/** Signs the user out of every device, everywhere. */
export async function logoutEverywhere(userId: string): Promise<void> {
  if (!isId(userId)) return;

  await db.transaction(async (tx) => {
    await revokeWhere(tx, eq(refreshTokens.userId, userId), 'logout_all');

    // Bumping the version invalidates every outstanding access token too,
    // without needing a blocklist.
    await tx
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));
  });
}

/* ------------------------------------------------------------------ */
/* Social login                                                        */
/* ------------------------------------------------------------------ */

export interface SocialProfile {
  provider: 'google';
  subject: string;
  email: string;
  name: string;
  avatarUrl: string;
  emailVerified: boolean;
}

/**
 * Signs in with a social provider, creating or linking an account.
 *
 * Linking by email is only safe when the provider has verified it.
 * Otherwise anyone could register an unverified account at a provider using
 * someone else's address and take over their account here.
 */
export async function socialLogin(
  profile: SocialProfile,
  device: DeviceInfo,
): Promise<{ user: Account; session: IssuedSession; created: boolean }> {
  const email = profile.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    // Already linked: the normal returning-user path.
    const [linked] = await tx
      .select({
        id: users.id,
        suspendedAt: users.suspendedAt,
        suspendedReason: users.suspendedReason,
      })
      .from(userIdentities)
      .innerJoin(users, eq(users.id, userIdentities.userId))
      .where(
        and(
          eq(userIdentities.provider, profile.provider),
          eq(userIdentities.subject, profile.subject),
          isNull(users.deletedAt),
        ),
      );

    if (linked) {
      assertNotSuspended(linked);
      const user = await touch(tx, linked.id);
      return { user, session: await issueSession(tx, user, device), created: false };
    }

    const [byEmail] = await tx
      .select({
        id: users.id,
        avatarUrl: users.avatarUrl,
        emailVerifiedAt: users.emailVerifiedAt,
        suspendedAt: users.suspendedAt,
        suspendedReason: users.suspendedReason,
      })
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)));

    if (byEmail) {
      assertNotSuspended(byEmail);

      if (!profile.emailVerified) {
        throw new HttpError(
          409,
          'That email already has an account. Sign in with your password to link Google.',
          'email_unverified_at_provider',
        );
      }

      await tx.insert(userIdentities).values({
        provider: profile.provider,
        subject: profile.subject,
        userId: byEmail.id,
        email,
      });

      await tx
        .update(users)
        .set({
          ...(!byEmail.avatarUrl && profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          ...(byEmail.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }),
        })
        .where(eq(users.id, byEmail.id));

      const user = await touch(tx, byEmail.id);

      logger.info(
        { userId: user.id, provider: profile.provider },
        'Linked social identity to existing account',
      );
      return { user, session: await issueSession(tx, user, device), created: false };
    }

    const userId = newId();

    await tx.insert(users).values({
      id: userId,
      email,
      name: profile.name.trim() || (email.split('@')[0] ?? 'New user'),
      avatarUrl: profile.avatarUrl,
      emailVerifiedAt: profile.emailVerified ? new Date() : null,
    });

    await tx.insert(userIdentities).values({
      provider: profile.provider,
      subject: profile.subject,
      userId,
      email,
    });

    const user = await touch(tx, userId);

    logger.info({ userId, provider: profile.provider }, 'Account created through social login');
    return { user, session: await issueSession(tx, user, device), created: true };
  });
}

/* ------------------------------------------------------------------ */
/* Password change                                                     */
/* ------------------------------------------------------------------ */

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const [found] = isId(userId)
    ? await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    : [];

  if (!found) throw new HttpError(404, 'Account not found.', 'user_not_found');

  if (found.passwordHash) {
    if (!(await verifyPassword(found.passwordHash, currentPassword))) {
      throw new HttpError(401, 'Your current password is not right.', 'invalid_credentials');
    }
  }

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      // Kill every outstanding access token along with the old password.
      .set({ passwordHash, tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));

    await revokeWhere(tx, eq(refreshTokens.userId, userId), 'password_changed');
  });

  logger.info({ userId }, 'Password changed; all sessions revoked');
}

/* ------------------------------------------------------------------ */
/* Active sessions                                                     */
/* ------------------------------------------------------------------ */

export interface ActiveSession {
  id: string;
  userAgent: string;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

export async function listSessions(
  userId: string,
  currentToken?: string,
): Promise<ActiveSession[]> {
  if (!isId(userId)) return [];

  const currentHash = currentToken ? hashRefreshToken(currentToken) : null;

  const rows = await db
    .select({
      id: refreshTokens.id,
      userAgent: refreshTokens.userAgent,
      tokenHash: refreshTokens.tokenHash,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(refreshTokens.createdAt));

  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    current: currentHash !== null && safeEquals(r.tokenHash, currentHash),
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const revoked =
    isId(userId) && isId(sessionId)
      ? await revokeWhere(
          db,
          and(eq(refreshTokens.id, sessionId), eq(refreshTokens.userId, userId)),
          'logout',
        ).returning({ id: refreshTokens.id })
      : [];

  if (revoked.length === 0) {
    throw new HttpError(404, 'That session was not found.', 'session_not_found');
  }
}

/** Constant-time comparison, so a timing difference reveals nothing. */
function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ */
/* Public shape                                                        */
/* ------------------------------------------------------------------ */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  locale: string;
  emailVerified: boolean;
  hasPassword: boolean;
  providers: string[];
  role: 'user' | 'admin';
}

/** Everything the client is allowed to know about the signed-in user. */
export function toPublicUser(user: Account): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    emailVerified: user.emailVerifiedAt !== null,
    // Generated by Postgres from the hash, so it cannot disagree with it.
    hasPassword: user.hasPassword,
    providers: user.providers,
    role: user.role,
  };
}
