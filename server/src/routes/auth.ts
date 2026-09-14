import { Router, type Request, type Response, type CookieOptions } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProduction } from '../config.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';
import { REFRESH_TOKEN_TTL_MS } from '../lib/tokens.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import * as auth from '../services/auth.js';
import * as google from '../services/google.js';

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

const REFRESH_COOKIE = 'pulse_rt';
const OAUTH_STATE_COOKIE = 'pulse_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'pulse_oauth_verifier';

/**
 * The refresh token lives in an httpOnly cookie so that JavaScript — ours or
 * an attacker's — cannot read it. `sameSite: lax` still allows the OAuth
 * redirect back from Google while blocking cross-site form posts.
 */
function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/** Short-lived cookies holding the OAuth handshake values. */
function oauthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 10 * 60 * 1000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

function setSession(res: Response, session: auth.IssuedSession): void {
  res.cookie(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
}

/**
 * The same cookie attributes, without a lifetime.
 *
 * A browser only clears a cookie when the attributes match the ones it was
 * set with, so these must be passed -- but Express 5 refuses maxAge here,
 * and passing it as undefined still counts as passing it.
 */
function withoutMaxAge<T extends { maxAge?: number }>(options: T): Omit<T, 'maxAge'> {
  const { maxAge: _lifetime, ...rest } = options;
  return rest;
}

function clearSession(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, withoutMaxAge(refreshCookieOptions()));
}

function deviceOf(req: Request): auth.DeviceInfo {
  return { userAgent: req.get('user-agent') ?? '', ip: req.ip ?? '' };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Length over composition rules. Forcing a symbol and a digit pushes people
 * toward `Password1!`, which is weaker than a long passphrase. 12 characters
 * with a check against the most common passwords is the better trade.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456789012',
  'qwertyuiop12',
  'iloveyou1234',
  'administrator',
  'letmein12345',
  'welcome12345',
]);

const zPassword = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'That password is too easy to guess.');

const zRegister = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
  password: zPassword,
  name: z.string().trim().min(1, 'Tell us your name.').max(100),
});

const zLogin = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
  password: z.string().min(1, 'Enter your password.').max(200),
});

const zChangePassword = z.object({
  currentPassword: z.string().max(200).default(''),
  newPassword: zPassword,
});

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

/**
 * Tight limits on the endpoints an attacker actually targets. Keyed by IP
 * and email together, so one attacker cannot lock out a legitimate user by
 * hammering their address from elsewhere.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
    return `${req.ip ?? 'unknown'}:${email}`;
  },
  message: {
    error: 'Too many attempts. Please wait a few minutes and try again.',
    code: 'rate_limited',
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many accounts created from here. Try again later.', code: 'rate_limited' },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export function authRoutes(): Router {
  const router = Router();

  /** Tells the client which sign-in methods this deployment offers. */
  router.get('/providers', (_req, res) => {
    res.json({ password: true, google: google.isGoogleConfigured() });
  });

  router.post('/register', registerLimiter, (req, res, next) => {
    void (async () => {
      try {
        const input = zRegister.parse(req.body);
        const { user, session } = await auth.register(input, deviceOf(req));
        setSession(res, session);
        res.status(201).json({ user: auth.toPublicUser(user), accessToken: session.accessToken });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/login', loginLimiter, (req, res, next) => {
    void (async () => {
      try {
        const { email, password } = zLogin.parse(req.body);
        const { user, session } = await auth.login(email, password, deviceOf(req));
        setSession(res, session);
        res.json({ user: auth.toPublicUser(user), accessToken: session.accessToken });
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Exchanges the refresh cookie for a new access token, rotating as it goes. */
  router.post('/refresh', (req, res, next) => {
    void (async () => {
      try {
        const cookies = req.cookies as Record<string, string | undefined>;
        const token = cookies[REFRESH_COOKIE];
        if (!token) throw new HttpError(401, 'Please sign in.', 'no_refresh_token');

        const { user, session } = await auth.refresh(token, deviceOf(req));
        setSession(res, session);
        res.json({ user: auth.toPublicUser(user), accessToken: session.accessToken });
      } catch (err) {
        // Any refresh failure means the cookie is worthless; clear it so the
        // client stops retrying with a token that will never work.
        clearSession(res);
        next(err);
      }
    })();
  });

  router.post('/logout', (req, res, next) => {
    void (async () => {
      try {
        const cookies = req.cookies as Record<string, string | undefined>;
        const token = cookies[REFRESH_COOKIE];
        if (token) await auth.logout(token);
        clearSession(res);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/logout-everywhere', requireAuth, (req, res, next) => {
    void (async () => {
      try {
        await auth.logoutEverywhere((req as AuthedRequest).user.id);
        clearSession(res);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/me', requireAuth, (req, res, next) => {
    void (async () => {
      try {
        const user = await auth.getAccount((req as AuthedRequest).user.id);
        if (!user) throw new HttpError(404, 'Account not found.', 'user_not_found');
        res.json({ user: auth.toPublicUser(user) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/change-password', requireAuth, (req, res, next) => {
    void (async () => {
      try {
        const { currentPassword, newPassword } = zChangePassword.parse(req.body);
        await auth.changePassword((req as AuthedRequest).user.id, currentPassword, newPassword);
        clearSession(res);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  /* ---------------- active sessions ---------------- */

  router.get('/sessions', requireAuth, (req, res, next) => {
    void (async () => {
      try {
        const cookies = req.cookies as Record<string, string | undefined>;
        const sessions = await auth.listSessions(
          (req as AuthedRequest).user.id,
          cookies[REFRESH_COOKIE],
        );
        res.json({ sessions });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.delete('/sessions/:id', requireAuth, (req, res, next) => {
    void (async () => {
      try {
        const sessionId = req.params.id;
        if (!sessionId) throw new HttpError(400, 'Missing session id.', 'bad_request');
        await auth.revokeSession((req as AuthedRequest).user.id, sessionId);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    })();
  });

  /* ---------------- google ---------------- */

  const googleRedirectUri = (): string => `${env.SERVER_ORIGIN}/api/auth/google/callback`;

  router.get('/google', (_req, res, next) => {
    try {
      const { url, state, codeVerifier } = google.buildAuthUrl(googleRedirectUri());
      res.cookie(OAUTH_STATE_COOKIE, state, oauthCookieOptions());
      res.cookie(OAUTH_VERIFIER_COOKIE, codeVerifier, oauthCookieOptions());
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  });

  router.get('/google/callback', (req, res) => {
    void (async () => {
      const finish = (path: string): void => {
        res.clearCookie(OAUTH_STATE_COOKIE, withoutMaxAge(oauthCookieOptions()));
        res.clearCookie(OAUTH_VERIFIER_COOKIE, withoutMaxAge(oauthCookieOptions()));
        res.redirect(`${env.CLIENT_ORIGIN}${path}`);
      };

      try {
        const query = z
          .object({
            code: z.string().min(1).optional(),
            state: z.string().min(1).optional(),
            error: z.string().optional(),
          })
          .parse(req.query);

        // The user pressed cancel at Google. Not an error worth shouting about.
        if (query.error) {
          finish('/signin?error=cancelled');
          return;
        }

        const cookies = req.cookies as Record<string, string | undefined>;
        const expectedState = cookies[OAUTH_STATE_COOKIE];
        const codeVerifier = cookies[OAUTH_VERIFIER_COOKIE];

        if (!query.code || !query.state || !expectedState || !codeVerifier) {
          finish('/signin?error=expired');
          return;
        }

        // Mismatched state means this callback did not originate from a
        // request we started. Refuse it.
        if (query.state !== expectedState) {
          logger.warn({ ip: req.ip }, 'OAuth state mismatch on Google callback');
          finish('/signin?error=invalid_state');
          return;
        }

        const profile = await google.completeGoogleSignIn(
          query.code,
          codeVerifier,
          googleRedirectUri(),
        );
        const { session } = await auth.socialLogin(profile, deviceOf(req));

        setSession(res, session);
        finish('/auth/complete');
      } catch (err) {
        res.clearCookie(OAUTH_STATE_COOKIE, withoutMaxAge(oauthCookieOptions()));
        res.clearCookie(OAUTH_VERIFIER_COOKIE, withoutMaxAge(oauthCookieOptions()));

        /*
         * Some failures here are decisions, not faults. Telling someone
         * whose account was suspended to "try again" invites them to try
         * again forever, and buries the real reason in a server log they
         * cannot read. Codes the sign-in screen knows how to explain are
         * passed through; anything else stays generic.
         */
        const code = err instanceof HttpError ? err.code : null;
        const known = code === 'account_suspended' || code === 'email_unverified_at_provider';

        if (known) logger.info({ code }, 'Google sign-in refused');
        else logger.error({ err }, 'Google callback failed');

        res.redirect(`${env.CLIENT_ORIGIN}/signin?error=${known ? code : 'google_failed'}`);
      }
    })();
  });

  return router;
}
