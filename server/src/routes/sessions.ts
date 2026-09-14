import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { isId } from '../db/ids.js';
import { sessions as sessionsTable, type Session } from '../db/schema.js';
import { requireAuth, type AuthedRequest } from '../middleware/requireAuth.js';
import * as sessions from '../services/sessions.js';
import * as exports from '../services/export.js';
import { joinOrigin, joinOrigins } from '../lib/network.js';

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
          collectNames: sessions.collectsNames(session),
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.use(requireAuth);

  const ownerOf = (req: unknown): string => (req as AuthedRequest).user.id;

  /**
   * Every session this user has run.
   *
   * The results of a session outlive the session: a teacher who ran a quiz
   * on Monday needs Monday's scores on Tuesday, and until this existed the
   * only way to an export was to still have the presenter view open.
   */
  router.get('/', (req, res, next) => {
    void (async () => {
      try {
        const query = z
          .object({
            deckId: z.string().max(64).optional(),
            /* Dates as YYYY-MM-DD, which is what a date input produces. */
            from: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            to: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .parse(req.query);

        const conditions: SQL[] = [eq(sessionsTable.ownerId, ownerOf(req))];

        // A malformed deck id matches nothing, rather than being ignored and
        // returning every session as if no filter had been asked for.
        if (query.deckId) {
          if (!isId(query.deckId)) {
            res.json({ sessions: [] });
            return;
          }
          conditions.push(eq(sessionsTable.deckId, query.deckId));
        }

        /*
         * Both ends inclusive, and read in the server's timezone.
         *
         * "To" covers the whole of that day rather than stopping at
         * midnight: someone filtering to today and seeing nothing from
         * this morning would reasonably conclude the filter is broken.
         */
        if (query.from) {
          conditions.push(gte(sessionsTable.startedAt, new Date(`${query.from}T00:00:00`)));
        }
        if (query.to) {
          conditions.push(lte(sessionsTable.startedAt, new Date(`${query.to}T23:59:59.999`)));
        }

        /*
         * Counted for real rather than read from the cached counters, which
         * can drift if a process died mid-session; a history page showing a
         * wrong number is worse than one that takes a moment longer.
         *
         * One query for the whole page. Counting per session was two round
         * trips a row -- two hundred for a full page.
         */
        const rows = await db
          .select({
            id: sessionsTable.id,
            deckId: sessionsTable.deckId,
            title: sessionsTable.title,
            joinCode: sessionsTable.joinCode,
            state: sessionsTable.state,
            startedAt: sessionsTable.startedAt,
            endedAt: sessionsTable.endedAt,
            participants: sql<number>`(
              SELECT count(*)::int FROM participants p
              WHERE p.session_id = ${sessionsTable.id} AND p.blocked_at IS NULL
            )`,
            responses: sql<number>`(
              SELECT count(*)::int FROM responses r
              WHERE r.session_id = ${sessionsTable.id} AND r.deleted_at IS NULL
            )`,
          })
          .from(sessionsTable)
          .where(and(...conditions))
          .orderBy(desc(sessionsTable.startedAt))
          .limit(query.limit);

        res.json({ sessions: rows });
      } catch (err) {
        next(err);
      }
    })();
  });

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
        const session = await sessions.findOwnedSession(req.params.sessionId, ownerOf(req));

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
        const session = await sessions.findOwnedSession(req.params.sessionId, ownerOf(req));

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

  /* ---------------- export ---------------- */

  /**
   * The session's data, in whichever shape the presenter wants.
   *
   * Results belong to the person who ran the session. A tool that makes them
   * hard to get out is one nobody should rely on.
   */
  router.get('/:sessionId/export', (req, res, next) => {
    void (async () => {
      try {
        const { format } = z
          .object({ format: z.enum(['csv', 'leaderboard', 'statistics', 'json']).default('csv') })
          .parse(req.query);

        const session = await sessions.findOwnedSession(req.params.sessionId, ownerOf(req));

        if (!session) {
          res.status(404).json({ error: 'That session was not found.', code: 'session_not_found' });
          return;
        }

        if (format === 'json') {
          const name = exports.exportFilename(session, 'results', 'json');
          res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
          res.json(await exports.sessionJson(session));
          return;
        }

        const csv =
          format === 'leaderboard'
            ? await exports.leaderboardCsv(session)
            : format === 'statistics'
              ? await exports.statisticsCsv(session)
              : await exports.responsesCsv(session);

        const name = exports.exportFilename(session, format, 'csv');

        // The BOM is what makes Excel open a UTF-8 CSV correctly; without it
        // every accented name and emoji arrives mangled.
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send('﻿' + csv);
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}

function toPublicSession(session: Session) {
  return {
    id: session.id,
    // Null once the deck has been deleted and purged; the session outlives it.
    deckId: session.deckId,
    title: session.title,
    joinCode: session.joinCode,
    joinSlug: session.joinSlug,
    // Built from the server's own configuration rather than guessed by the
    // browser: the presenter's machine knows its address, but the tab
    // showing this page may have been opened on localhost, which is not
    // reachable from anyone else's phone.
    // The deck's theme travels with the session, so the presenter view
    // shows the accent the author chose rather than the default.
    theme: sessions.snapshotOf(session).theme,
    joinUrl: joinOrigin(),
    joinLink: `${joinOrigin()}/?code=${session.joinCode}`,
    // Every address this machine has, so a presenter whose room cannot
    // reach the first one can switch rather than guess.
    joinUrls: joinOrigins(),
    state: session.state,
    mode: session.mode,
    currentSlideId: session.currentSlideId,
    participationOpen: session.participationOpen,
    resultsVisible: session.resultsVisible,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}
