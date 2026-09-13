import {
  Deck,
  Session,
  Response,
  Participant,
  AudienceQuestion,
  RefreshToken,
} from '../models/index.js';
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

  const deckCutoff = new Date(now - DECK_GRACE_DAYS * DAY_MS);

  const oldDecks = await Deck.find({ deletedAt: { $ne: null, $lt: deckCutoff } })
    .select('_id')
    .lean();

  if (oldDecks.length > 0) {
    const ids = oldDecks.map((deck) => deck._id);

    // The deck goes, but its sessions stay: someone who deleted a deck did
    // not ask to lose the record of the times they presented it.
    const result = await Deck.deleteMany({ _id: { $in: ids } });
    report.decksPurged = result.deletedCount;
  }

  /* ---------------- answers from long finished sessions ---------------- */

  const responseCutoff = new Date(now - RESPONSE_RETENTION_DAYS * DAY_MS);

  const oldSessions = await Session.find({
    state: 'closed',
    endedAt: { $ne: null, $lt: responseCutoff },
  })
    .select('_id')
    .lean();

  if (oldSessions.length > 0) {
    const ids = oldSessions.map((session) => session._id);

    const [responses, participants, questions] = await Promise.all([
      Response.deleteMany({ sessionId: { $in: ids } }),
      Participant.deleteMany({ sessionId: { $in: ids } }),
      AudienceQuestion.deleteMany({ sessionId: { $in: ids } }),
    ]);

    report.responsesPurged = responses.deletedCount;
    report.participantsPurged = participants.deletedCount;
    report.questionsPurged = questions.deletedCount;
  }

  /* ---------------- revoked tokens ---------------- */

  // The TTL index handles expiry; this catches tokens revoked long ago,
  // which have no expiry to wait for.
  const tokenCutoff = new Date(now - 30 * DAY_MS);
  const tokens = await RefreshToken.deleteMany({ revokedAt: { $ne: null, $lt: tokenCutoff } });
  report.tokensPurged = tokens.deletedCount;

  /* ---------------- sessions nobody closed ---------------- */

  /*
   * A session left live for a day was almost certainly abandoned: the
   * presenter closed their laptop rather than pressing End. Closing it
   * releases the join code and stops it appearing as live to an admin.
   *
   * Twelve hours would catch a long conference day; twenty-four will not
   * touch anything real.
   */
  const staleCutoff = new Date(now - DAY_MS);

  const stale = await Session.updateMany(
    { state: { $in: ['live', 'paused'] }, startedAt: { $lt: staleCutoff } },
    { $set: { state: 'closed', endedAt: new Date(), participationOpen: false } },
  );
  report.staleSessionsClosed = stale.modifiedCount;

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
