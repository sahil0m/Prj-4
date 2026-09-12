import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config.js';
import { HttpError } from '../app.js';
import type { SocialProfile } from './auth.js';

/**
 * Google Sign-In, implemented as Authorization Code + PKCE.
 *
 * Two protections, both of which matter:
 *
 *   STATE guards against cross-site request forgery on the callback. We
 *   generate it, store it in a short-lived cookie, and refuse any callback
 *   whose state does not match.
 *
 *   PKCE guards against the authorization code being intercepted. We send a
 *   hash of a secret up front and the secret itself when exchanging, so a
 *   stolen code is useless without it.
 *
 * The ID token is verified against Google's published keys rather than
 * decoded and trusted, because an unverified token is just a string the
 * caller chose.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function requireConfig(): { clientId: string; clientSecret: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(
      503,
      'Google sign-in is not configured on this server.',
      'google_not_configured',
    );
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

/* ------------------------------------------------------------------ */
/* Step 1: build the authorization URL                                 */
/* ------------------------------------------------------------------ */

export interface AuthStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export function buildAuthUrl(redirectUri: string): AuthStart {
  const { clientId } = requireConfig();

  const state = randomBytes(24).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    // Ask for an account picker rather than silently reusing the last one,
    // which is a common source of "signed into the wrong account" support.
    prompt: 'select_account',
  });

  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state, codeVerifier };
}

/* ------------------------------------------------------------------ */
/* Step 2: exchange the code                                           */
/* ------------------------------------------------------------------ */

const zTokenResponse = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
});

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  const { clientId, clientSecret } = requireConfig();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new HttpError(401, 'Google sign-in failed. Please try again.', 'google_exchange_failed');
  }

  const parsed = zTokenResponse.safeParse(await response.json());
  if (!parsed.success) {
    throw new HttpError(502, 'Google returned an unexpected response.', 'google_bad_response');
  }

  return parsed.data.id_token;
}

/* ------------------------------------------------------------------ */
/* Step 3: verify the ID token                                         */
/* ------------------------------------------------------------------ */

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg: string;
  kty: string;
  use?: string;
}

/** Google rotates its keys, so the set is cached briefly rather than forever. */
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new HttpError(502, 'Could not reach Google to verify sign-in.', 'google_jwks_failed');
  }

  const parsed = z
    .object({ keys: z.array(z.object({}).passthrough()) })
    .safeParse(await response.json());

  if (!parsed.success) {
    throw new HttpError(502, 'Google returned unexpected signing keys.', 'google_bad_jwks');
  }

  const keys = parsed.data.keys as unknown as Jwk[];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

const zIdTokenClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  exp: z.number(),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

function base64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Verifies the RS256 signature against Google's published key, then checks
 * issuer, audience and expiry. Skipping any of these turns the whole flow
 * into "trust whatever the browser sent".
 */
async function verifyIdToken(idToken: string): Promise<z.infer<typeof zIdTokenClaims>> {
  const { clientId } = requireConfig();

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_malformed_token');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = z
    .object({ kid: z.string(), alg: z.literal('RS256') })
    .safeParse(JSON.parse(base64UrlToBuffer(headerB64).toString('utf8')));

  if (!header.success) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_bad_token_header');
  }

  const key = (await getJwks()).find((k) => k.kid === header.data.kid);
  if (!key) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_unknown_key');
  }

  const { createPublicKey, createVerify } = await import('node:crypto');
  const publicKey = createPublicKey({
    key: { kty: 'RSA', n: key.n, e: key.e },
    format: 'jwk',
  });

  const valid = createVerify('RSA-SHA256')
    .update(`${headerB64}.${payloadB64}`)
    .verify(publicKey, base64UrlToBuffer(signatureB64));

  if (!valid) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_bad_signature');
  }

  const claims = zIdTokenClaims.safeParse(
    JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8')),
  );
  if (!claims.success) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_bad_claims');
  }

  if (!GOOGLE_ISSUERS.includes(claims.data.iss)) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_bad_issuer');
  }
  if (claims.data.aud !== clientId) {
    throw new HttpError(401, 'Google sign-in failed.', 'google_bad_audience');
  }
  if (claims.data.exp * 1000 < Date.now()) {
    throw new HttpError(401, 'That sign-in attempt expired. Please try again.', 'google_expired');
  }

  return claims.data;
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

export async function completeGoogleSignIn(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<SocialProfile> {
  const idToken = await exchangeCode(code, codeVerifier, redirectUri);
  const claims = await verifyIdToken(idToken);

  return {
    provider: 'google',
    subject: claims.sub,
    email: claims.email,
    name: claims.name ?? '',
    avatarUrl: claims.picture ?? '',
    emailVerified: claims.email_verified ?? false,
  };
}
