import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'node:crypto';
import { env } from '../config.js';

/**
 * Token strategy.
 *
 * Access tokens are short-lived JWTs held in memory by the client. Refresh
 * tokens are long-lived opaque strings stored in an httpOnly cookie and
 * hashed in the database.
 *
 * Two properties matter:
 *
 *   ROTATION — every refresh issues a new refresh token and retires the old
 *   one. A stolen token is therefore useful for one request at most.
 *
 *   REUSE DETECTION — if a retired token is presented again, that means two
 *   parties hold the same token, so one of them is an attacker. We cannot
 *   tell which, so we revoke the entire family and force a fresh login.
 *   This is the mechanism that turns token theft from an open-ended breach
 *   into a single-use window.
 *
 * The refresh token is never stored in plain text. A database leak must not
 * hand an attacker working credentials.
 */

export const ACCESS_TOKEN_TTL = '15m';
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Bumped on password change and "log out everywhere"; stale tokens die. */
  tv: number;
  email: string;
  name: string;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.AUTH_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
    issuer: 'pulse',
    audience: 'pulse-web',
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = jwt.verify(token, env.AUTH_SECRET, {
    issuer: 'pulse',
    audience: 'pulse-web',
    algorithms: ['HS256'],
  });

  if (typeof payload === 'string') throw new Error('Malformed token payload');

  const { sub, tv, email, name } = payload as Partial<AccessTokenClaims>;
  if (typeof sub !== 'string' || typeof tv !== 'number') {
    throw new Error('Token is missing required claims');
  }

  return { sub, tv, email: email ?? '', name: name ?? '' };
}

/**
 * A refresh token is 32 random bytes, not a JWT. It carries no claims and
 * cannot be forged or read — it is purely a lookup key.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 rather than a password hash. The token already has 256 bits of
 * entropy, so there is nothing to brute force, and refresh happens on a hot
 * path where a deliberately slow hash would cost real latency.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Groups every token descended from one login, so reuse can revoke the lot. */
export function generateTokenFamily(): string {
  return randomBytes(16).toString('hex');
}

/** Single-use token for email verification and password reset. */
export function generateOneTimeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}
