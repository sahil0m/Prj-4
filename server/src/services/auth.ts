import argon2 from 'argon2';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';
import { User, RefreshToken, type UserDoc } from '../models/index.js';
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

function claimsFor(user: UserDoc) {
  return {
    sub: user._id.toString(),
    tv: user.tokenVersion,
    email: user.email,
    name: user.name,
  };
}

async function issueSession(
  user: UserDoc,
  device: DeviceInfo,
  family = generateTokenFamily(),
): Promise<IssuedSession> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await RefreshToken.create({
    userId: user._id,
    tokenHash: hashRefreshToken(refreshToken),
    family,
    expiresAt,
    userAgent: device.userAgent.slice(0, 300),
    ipHash: hashIp(device.ip),
  });

  return { accessToken: signAccessToken(claimsFor(user)), refreshToken, expiresAt };
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
): Promise<{ user: UserDoc; session: IssuedSession }> {
  const email = input.email.trim().toLowerCase();

  const existing = await User.findOne({ email }).select('+passwordHash');

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

  const user = await User.create({
    email,
    passwordHash: await hashPassword(input.password),
    name: input.name.trim(),
  });

  logger.info({ userId: user._id.toString() }, 'Account created');
  return { user, session: await issueSession(user, device) };
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

export async function login(
  email: string,
  password: string,
  device: DeviceInfo,
): Promise<{ user: UserDoc; session: IssuedSession }> {
  const normalised = email.trim().toLowerCase();
  const user = await User.findOne({ email: normalised, deletedAt: null }).select('+passwordHash');

  // Always run a verification, even with no user, so the response time does
  // not reveal whether the account exists.
  const hash = user?.passwordHash ?? (await getDecoyHash());
  const ok = await verifyPassword(hash, password);

  if (!user || !ok || !user.passwordHash) {
    throw new HttpError(401, 'That email or password is not right.', 'invalid_credentials');
  }

  user.lastSeenAt = new Date();
  await user.save();

  return { user, session: await issueSession(user, device) };
}

/* ------------------------------------------------------------------ */
/* Refresh, with rotation and reuse detection                          */
/* ------------------------------------------------------------------ */

export async function refresh(
  presentedToken: string,
  device: DeviceInfo,
): Promise<{ user: UserDoc; session: IssuedSession }> {
  const tokenHash = hashRefreshToken(presentedToken);
  const record = await RefreshToken.findOne({ tokenHash });

  if (!record) {
    throw new HttpError(401, 'Please sign in again.', 'invalid_refresh_token');
  }

  /*
   * The token exists but has already been exchanged. Two parties therefore
   * hold it, and we cannot tell which is legitimate. Revoke the whole family
   * so both are forced to re-authenticate — the attacker loses access, and
   * the real user is inconvenienced once rather than silently compromised.
   */
  if (record.usedAt || record.revokedAt) {
    await RefreshToken.updateMany(
      { family: record.family, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );
    // Mongoose types this loosely; the runtime value is an ObjectId.
    const ownerId = (record.userId as Types.ObjectId).toString();
    logger.warn(
      { userId: ownerId, family: record.family },
      'Refresh token reuse detected; token family revoked',
    );
    throw new HttpError(401, 'Please sign in again.', 'token_reuse_detected');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    throw new HttpError(401, 'Your session expired. Please sign in again.', 'refresh_expired');
  }

  const user = await User.findOne({ _id: record.userId, deletedAt: null });
  if (!user) {
    throw new HttpError(401, 'Please sign in again.', 'user_not_found');
  }

  // Retire the presented token, then issue a replacement in the same family.
  record.usedAt = new Date();
  record.revokedAt = new Date();
  record.revokedReason = 'rotated';
  await record.save();

  user.lastSeenAt = new Date();
  await user.save();

  return { user, session: await issueSession(user, device, record.family) };
}

/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */

export async function logout(presentedToken: string): Promise<void> {
  const record = await RefreshToken.findOne({ tokenHash: hashRefreshToken(presentedToken) });
  if (!record) return; // Already gone. Nothing to do, and nothing to reveal.

  await RefreshToken.updateMany(
    { family: record.family, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

/** Signs the user out of every device, everywhere. */
export async function logoutEverywhere(userId: string): Promise<void> {
  const id = new Types.ObjectId(userId);

  await RefreshToken.updateMany(
    { userId: id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout_all' } },
  );

  // Bumping the version invalidates every outstanding access token too,
  // without needing a blocklist.
  await User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
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
): Promise<{ user: UserDoc; session: IssuedSession; created: boolean }> {
  const email = profile.email.trim().toLowerCase();

  // Already linked: the normal returning-user path.
  const linked = await User.findOne({
    'identities.provider': profile.provider,
    'identities.subject': profile.subject,
    deletedAt: null,
  });

  if (linked) {
    linked.lastSeenAt = new Date();
    await linked.save();
    return { user: linked, session: await issueSession(linked, device), created: false };
  }

  const byEmail = await User.findOne({ email, deletedAt: null });

  if (byEmail) {
    if (!profile.emailVerified) {
      throw new HttpError(
        409,
        'That email already has an account. Sign in with your password to link Google.',
        'email_unverified_at_provider',
      );
    }

    byEmail.identities.push({
      provider: profile.provider,
      subject: profile.subject,
      email,
      linkedAt: new Date(),
    });
    if (!byEmail.avatarUrl && profile.avatarUrl) byEmail.avatarUrl = profile.avatarUrl;
    byEmail.emailVerifiedAt ??= new Date();
    byEmail.lastSeenAt = new Date();
    await byEmail.save();

    logger.info(
      { userId: byEmail._id.toString(), provider: profile.provider },
      'Linked social identity to existing account',
    );
    return { user: byEmail, session: await issueSession(byEmail, device), created: false };
  }

  const user = await User.create({
    email,
    name: profile.name.trim() || email.split('@')[0],
    avatarUrl: profile.avatarUrl,
    emailVerifiedAt: profile.emailVerified ? new Date() : null,
    identities: [
      { provider: profile.provider, subject: profile.subject, email, linkedAt: new Date() },
    ],
  });

  logger.info(
    { userId: user._id.toString(), provider: profile.provider },
    'Account created through social login',
  );
  return { user, session: await issueSession(user, device), created: true };
}

/* ------------------------------------------------------------------ */
/* Password change                                                     */
/* ------------------------------------------------------------------ */

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new HttpError(404, 'Account not found.', 'user_not_found');

  if (user.passwordHash) {
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new HttpError(401, 'Your current password is not right.', 'invalid_credentials');
    }
  }

  user.passwordHash = await hashPassword(newPassword);
  user.tokenVersion += 1; // Kill every outstanding access token.
  await user.save();

  await RefreshToken.updateMany(
    { userId: user._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } },
  );

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
  const currentHash = currentToken ? hashRefreshToken(currentToken) : null;

  const rows = await RefreshToken.find({
    userId: new Types.ObjectId(userId),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .lean();

  return rows.map((r) => ({
    id: r._id.toString(),
    userAgent: r.userAgent,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    current: currentHash !== null && safeEquals(r.tokenHash, currentHash),
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const result = await RefreshToken.updateOne(
    { _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
  if (result.matchedCount === 0) {
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
export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    locale: user.locale,
    emailVerified: user.emailVerifiedAt !== null,
    // The stored flag, not the hash: passwordHash is select:false and is
    // absent on most queries. See the note on the field in models/User.ts.
    hasPassword: user.hasPassword,
    providers: user.identities.map((i) => i.provider),
    role: user.role,
  };
}
