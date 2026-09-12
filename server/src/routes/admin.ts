import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin, type AuthedRequest } from '../middleware/requireAuth.js';
import * as admin from '../services/admin.js';

/**
 * The admin area.
 *
 * Every route is behind requireAdmin, which returns 404 rather than 403 for
 * an ordinary user: confirming that an admin area exists tells an attacker
 * where to aim, and a normal user has no reason to learn either way.
 */

const zUserList = z.object({
  search: z.string().trim().max(200).optional(),
  suspendedOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(64).optional(),
});

const zSuspend = z.object({
  suspended: z.boolean(),
  reason: z.string().trim().max(300).default(''),
});

const zRole = z.object({ role: z.enum(['user', 'admin']) });

export function adminRoutes(): Router {
  const router = Router();

  router.use(requireAuth);
  router.use(requireAdmin);

  const actorOf = (req: unknown): string => (req as AuthedRequest).user.id;

  /** Everything an admin needs at a glance. */
  router.get('/overview', (_req, res, next) => {
    void (async () => {
      try {
        res.json(await admin.overview());
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/users', (req, res, next) => {
    void (async () => {
      try {
        const query = zUserList.parse(req.query);
        res.json(await admin.listUsers(query));
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Suspends or restores an account. Takes effect on the next request. */
  router.post('/users/:userId/suspend', (req, res, next) => {
    void (async () => {
      try {
        const { suspended, reason } = zSuspend.parse(req.body);
        await admin.setSuspended(actorOf(req), req.params.userId, suspended, reason);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/users/:userId/role', (req, res, next) => {
    void (async () => {
      try {
        const { role } = zRole.parse(req.body);
        await admin.setRole(actorOf(req), req.params.userId, role);
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    })();
  });

  /** What is running right now. */
  router.get('/sessions', (_req, res, next) => {
    void (async () => {
      try {
        res.json({ sessions: await admin.liveSessions() });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
