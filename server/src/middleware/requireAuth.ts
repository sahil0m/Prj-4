import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../app.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { User } from '../models/index.js';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface AuthedRequest extends Request {
  user: AuthedUser;
}

/**
 * Requires a valid access token.
 *
 * The token's `tv` claim is checked against the user's current tokenVersion.
 * That is what makes "log out everywhere" and "password changed" take effect
 * immediately, without maintaining a blocklist of revoked tokens.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    try {
      const header = req.get('authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new HttpError(401, 'Please sign in.', 'no_token');
      }

      let claims;
      try {
        claims = verifyAccessToken(header.slice(7));
      } catch {
        // Expired or tampered. The client should refresh, not re-login, so
        // the code is distinct from a missing token.
        throw new HttpError(401, 'Your session expired.', 'token_expired');
      }

      const user = await User.findOne({ _id: claims.sub, deletedAt: null })
        .select('tokenVersion email name role suspendedAt suspendedReason')
        .lean();

      if (!user) {
        throw new HttpError(401, 'Please sign in.', 'user_not_found');
      }

      if (user.tokenVersion !== claims.tv) {
        throw new HttpError(401, 'Your session ended. Please sign in again.', 'token_revoked');
      }

      // Checked on every request rather than only at sign-in, so suspending
      // an account stops it immediately rather than when a token expires.
      if (user.suspendedAt) {
        throw new HttpError(
          403,
          user.suspendedReason || 'This account has been suspended.',
          'account_suspended',
        );
      }

      (req as AuthedRequest).user = {
        id: claims.sub,
        email: user.email,
        name: user.name,
        role: user.role,
      };

      next();
    } catch (err) {
      next(err);
    }
  })();
}

/**
 * Attaches the user when a valid token is present, but never rejects.
 * Used on routes that behave differently for signed-in visitors without
 * requiring an account.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }

    try {
      const claims = verifyAccessToken(header.slice(7));
      const user = await User.findOne({ _id: claims.sub, deletedAt: null })
        .select('tokenVersion email name role suspendedAt')
        .lean();

      if (user?.tokenVersion === claims.tv && !user.suspendedAt) {
        (req as AuthedRequest).user = {
          id: claims.sub,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      }
    } catch {
      // A bad token on an optional route is simply ignored.
    }

    next();
  })();
}

/**
 * Requires an admin.
 *
 * Mounted after requireAuth, and returns 404 rather than 403 for a
 * non-admin: confirming that an admin area exists tells an attacker where
 * to aim, and an ordinary user has no reason to know either way.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user;

  if (user.role !== 'admin') {
    res.status(404).json({ error: 'Not found.', code: 'not_found' });
    return;
  }

  next();
}
