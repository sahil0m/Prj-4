import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { env } from '../config.js';
import { Session } from '../models/index.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import * as sessions from '../services/sessions.js';

/**
 * Session lifecycle over HTTP.
 *
 * Starting and ending a session is a normal request; everything that happens
 * during one goes over the socket. The split keeps the realtime layer free of
 * anything that needs to be durable and idempotent at the HTTP level.
 */

const zStart = z.object({ deckId: z.string().max(64) });
const zLookup = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});

export function sessionRoutes(): Router {
  const router = Router();

  /**
   * Public: does this join code lead anywhere?
   *
   * Deliberately before requireAuth, and deliberately thin. It returns only
   * what a phone needs to show a title before joining, never the deck or the
   * session id, which would let anyone enumerate live sessions.
   */
  router.get('/lookup', (req, res, next) => {
    void (async () => {
      try {
        const { code } = zLookup.parse(req.query);
        const session = await sessions.findByJoinCode(code);

        res.json({
          title: session.title,
          state: session.state,
          collectNames: sessions.snapshotOf(session).settings?.collectNames === true,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.use(requireAuth);

  const ownerOf = (req: unknown): string => (req as AuthedRequest).user.id;

  router.post('/', (req, res, next) => {
    void (async () => {
      try {
        const { deckId } = zStart.parse(req.body);
        const session = await sessions.startSession(deckId, ownerOf(req));
        res.status(201).json({ session: toPublicSession(session) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.get('/:sessionId', (req, res, next) => {
    void (async () => {
      try {
        const session = await Session.findOne({
          _id: req.params.sessionId,
          ownerId: ownerOf(req),
        });

        if (!session) {
          res.status(404).json({ error: 'That session was not found.', code: 'session_not_found' });
          return;
        }

        res.json({ session: toPublicSession(session), snapshot: sessions.snapshotOf(session) });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.post('/:sessionId/end', (req, res, next) => {
    void (async () => {
      try {
        const session = await sessions.endSession(req.params.sessionId, ownerOf(req));
        res.json({ session: toPublicSession(session) });
      } catch (err) {
        next(err);
      }
    })();
  });

  /** Results for one slide, for the presenter and for the export. */
  router.get('/:sessionId/slides/:slideId/results', (req, res, next) => {
    void (async () => {
      try {
        const session = await Session.findOne({
          _id: req.params.sessionId,
          ownerId: ownerOf(req),
        });

        if (!session) {
          res.status(404).json({ error: 'That session was not found.', code: 'session_not_found' });
          return;
        }

        const results = await sessions.resultsFor(session, req.params.slideId);
        if (!results) {
          res.status(404).json({ error: 'That slide was not found.', code: 'slide_not_found' });
          return;
        }

        res.json({ results });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function toPublicSession(session: Awaited<ReturnType<typeof sessions.startSession>>) {
  return {
    id: session._id.toString(),
    // Never populated on this path, so this is always an ObjectId.
    deckId: (session.deckId as Types.ObjectId).toString(),
    title: session.title,
    joinCode: session.joinCode,
    joinSlug: session.joinSlug,
    // Built from the server's own configuration rather than guessed by the
    // browser: the presenter's machine knows its address, but the tab
    // showing this page may have been opened on localhost, which is not
    // reachable from anyone else's phone.
    joinUrl: env.JOIN_ORIGIN,
    joinLink: `${env.JOIN_ORIGIN}/?code=${session.joinCode}`,
    state: session.state,
    mode: session.mode,
    currentSlideId: session.currentSlideId ?? null,
    participationOpen: session.participationOpen,
    resultsVisible: session.resultsVisible,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}
