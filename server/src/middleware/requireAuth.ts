import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../app.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { User } from '../models/index.js';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
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
        .select('tokenVersion email name')
        .lean();

      if (!user) {
        throw new HttpError(401, 'Please sign in.', 'user_not_found');
      }

      if (user.tokenVersion !== claims.tv) {
        throw new HttpError(401, 'Your session ended. Please sign in again.', 'token_revoked');
      }

      (req as AuthedRequest).user = {
        id: claims.sub,
        email: user.email,
        name: user.name,
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
        .select('tokenVersion email name')
        .lean();

      if (user?.tokenVersion === claims.tv) {
        (req as AuthedRequest).user = { id: claims.sub, email: user.email, name: user.name };
      }
    } catch {
      // A bad token on an optional route is simply ignored.
    }

    next();
  })();
}
