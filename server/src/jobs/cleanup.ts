import { and, count, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  decks,
  sessions,
  participants,
  responses,
  audienceQuestions,
  refreshTokens,
} from '../db/schema.js';
import { logger } from '../lib/logger.js';

/**
 * Removing what is no longer needed.
 *
 * Two model comments promised that "a job purges rows older than 30 days"
 * and no such job existed, so soft-deleted decks and the responses of long
 * finished sessions accumulated indefinitely. A database that only grows is
 * a slow outage rather than a fast one.
 *
 * Everything here is conservative. Deleting a presenter's results because
 * of an off-by-one in a retention window is unrecoverable, so each rule
 * errs towards keeping data and every run reports what it removed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a soft-deleted deck stays recoverable. */
const DECK_GRACE_DAYS = 30;

/**
 * How long raw answers are kept after a session ends.
 *
 * Deliberately long: a presenter may export months later, and the whole
 * point of the history page is that results outlive the session. Only the
 * individual answers go; the session row and its counts remain, so the
 * history page still shows that it happened.
 */
const RESPONSE_RETENTION_DAYS = 365;

export interface CleanupReport {
  decksPurged: number;
  responsesPurged: number;
  participantsPurged: number;
  questionsPurged: number;
  tokensPurged: number;
  staleSessionsClosed: number;
}

/**
 * Runs every rule once.
 *
 * Safe to call repeatedly and safe to call concurrently: every operation is
 * an idempotent delete of rows that already met their condition.
 */
export async function runCleanup(): Promise<CleanupReport> {
  const now = Date.now();

  const report: CleanupReport = {
    decksPurged: 0,
    responsesPurged: 0,
    participantsPurged: 0,
    questionsPurged: 0,
    tokensPurged: 0,
    staleSessionsClosed: 0,
  };

  /* ---------------- decks past their grace period ---------------- */

  // The deck goes, but its sessions stay: their deck_id is set to null by the
  // foreign key, because someone who deleted a deck did not ask to lose the
  // record of the times they presented it.
  const purgedDecks = await db
    .delete(decks)
    .where(
      and(
        isNotNull(decks.deletedAt),
        lt(decks.deletedAt, new Date(now - DECK_GRACE_DAYS * DAY_MS)),
      ),
    )
    .returning({ id: decks.id });

  report.decksPurged = purgedDecks.length;

  /* ---------------- answers from long finished sessions ---------------- */

  const old = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.state, 'closed'),
        isNotNull(sessions.endedAt),
        lt(sessions.endedAt, new Date(now - RESPONSE_RETENTION_DAYS * DAY_MS)),
      ),
    );

  if (old.length > 0) {
    const ids = old.map((row) => row.id);

    /*
     * Counted before deleting, then removed through participants alone:
     * responses and questions both reference a participant with ON DELETE
     * CASCADE, so one statement takes all three and they can never be left
     * pointing at someone who no longer exists. Inside a transaction so the
     * counts reported are the rows actually removed.
     */
    await db.transaction(async (tx) => {
      // One after another: a transaction is a single connection, and
      // queries sent over it at once would only queue up anyway.
      const responseCount = await tx
        .select({ value: count() })
        .from(responses)
        .where(inArray(responses.sessionId, ids));
      const participantCount = await tx
        .select({ value: count() })
        .from(participants)
        .where(inArray(participants.sessionId, ids));
      const questionCount = await tx
        .select({ value: count() })
        .from(audienceQuestions)
        .where(inArray(audienceQuestions.sessionId, ids));

      await tx.delete(participants).where(inArray(participants.sessionId, ids));

      report.responsesPurged = responseCount[0]?.value ?? 0;
      report.participantsPurged = participantCount[0]?.value ?? 0;
      report.questionsPurged = questionCount[0]?.value ?? 0;
    });
  }

  /* ---------------- refresh tokens ---------------- */

  /*
   * MongoDB removed expired tokens itself, through a TTL index. Postgres has
   * no such thing, so without this the table grows by a row on every refresh
   * forever. Revoked tokens are kept for a month first, because a revoked
   * token being presented again is the signal reuse detection relies on.
   */
  const tokenCutoff = new Date(now - 30 * DAY_MS);

  const purgedTokens = await db
    .delete(refreshTokens)
    .where(
      or(
        lt(refreshTokens.expiresAt, new Date(now)),
        and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, tokenCutoff)),
      ),
    )
    .returning({ id: refreshTokens.id });

  report.tokensPurged = purgedTokens.length;

  /* ---------------- sessions nobody closed ---------------- */

  /*
   * A session left live for a day was almost certainly abandoned: the
   * presenter closed their laptop rather than pressing End. Closing it
   * releases the join code and stops it appearing as live to an admin.
   *
   * Twelve hours would catch a long conference day; twenty-four will not
   * touch anything real.
   */
  const closed = await db
    .update(sessions)
    .set({ state: 'closed', endedAt: new Date(), participationOpen: false })
    .where(
      and(
        inArray(sessions.state, ['live', 'paused']),
        lt(sessions.startedAt, new Date(now - DAY_MS)),
      ),
    )
    .returning({ id: sessions.id });

  report.staleSessionsClosed = closed.length;

  const total =
    report.decksPurged +
    report.responsesPurged +
    report.participantsPurged +
    report.questionsPurged +
    report.tokensPurged +
    report.staleSessionsClosed;

  // Logged only when it did something, so a quiet server stays quiet.
  if (total > 0) logger.info(report, 'Cleanup complete');

  return report;
}

/**
 * Starts the cleanup schedule.
 *
 * Hourly rather than daily: an hourly run does a small amount of work each
 * time, where a daily one wakes up to a large deletion that competes with
 * whatever else the database is doing. The first run is delayed so it never
 * lands during startup, when connections are still settling.
 */
export function startCleanup(): () => void {
  const HOUR_MS = 60 * 60 * 1000;

  const run = () => {
    void runCleanup().catch((err: unknown) => {
      // A failed cleanup is not worth taking the server down for; the next
      // run will pick up whatever this one missed.
      logger.error({ err }, 'Cleanup failed');
    });
  };

  const first = setTimeout(run, 5 * 60 * 1000);
  const repeating = setInterval(run, HOUR_MS);

  // Unref'd, so a pending timer never holds the process open during a
  // shutdown that is otherwise complete.
  first.unref();
  repeating.unref();

  return () => {
    clearTimeout(first);
    clearInterval(repeating);
  };
}
