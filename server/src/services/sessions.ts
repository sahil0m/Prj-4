import { randomInt, randomBytes } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, isUniqueViolation } from '../lib/db.js';
import { newId, isId } from '../db/ids.js';
import {
  decks,
  sessions,
  participants,
  responses,
  audienceQuestions,
  type Session,
  type Participant,
  type AudienceQuestion,
  type DeckSnapshot,
} from '../db/schema.js';
import { orderedSlides, settingsOf, themeOf } from './decks.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';
import { isProfane } from './profanity.js';
import {
  aggregate,
  definitionFor,
  isAnswerable,
  scoreAnswer,
  unknownIds,
  buildLeaderboard,
  zAnswer,
  type LeaderboardEntry,
  type SlideKind,
  type SessionState,
  type ParticipantSlide,
  type SlideResults,
} from '@pulse/shared';

/**
 * Running a deck in front of a room.
 *
 * A session freezes the deck at the moment it starts. Editing the deck
 * afterwards cannot change what a past session's numbers mean, which is the
 * whole reason the snapshot exists.
 */

const sessionNotFound = () =>
  new HttpError(404, 'That session was not found.', 'session_not_found');

/* ------------------------------------------------------------------ */
/* Join codes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Six digits, random rather than sequential.
 *
 * Sequential codes would let anyone who joined one session guess the next.
 * Uniqueness among joinable sessions is enforced by a partial unique index,
 * so the space is never exhausted however many sessions have ever run.
 */
function randomJoinCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Permanent and never reissued, so it is safe on a printed handout. */
function newJoinSlug(): string {
  return randomBytes(8)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** A session by id, for a participant's socket. Null if it does not exist. */
export async function getSession(sessionId: string): Promise<Session | null> {
  if (!isId(sessionId)) return null;
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return session ?? null;
}

/** A session its owner is asking for, or null. */
export async function findOwnedSession(
  sessionId: string,
  ownerId: string,
): Promise<Session | null> {
  if (!isId(sessionId) || !isId(ownerId)) return null;

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)));

  return session ?? null;
}

async function ownedSession(sessionId: string, ownerId: string): Promise<Session> {
  const session = await findOwnedSession(sessionId, ownerId);
  if (!session) throw sessionNotFound();
  return session;
}

export async function getParticipant(participantId: string): Promise<Participant | null> {
  if (!isId(participantId)) return null;
  const [participant] = await db
    .select()
    .from(participants)
    .where(eq(participants.id, participantId));
  return participant ?? null;
}

/* ------------------------------------------------------------------ */
/* Starting and ending                                                 */
/* ------------------------------------------------------------------ */

export async function startSession(deckId: string, ownerId: string): Promise<Session> {
  if (!isId(deckId) || !isId(ownerId)) {
    throw new HttpError(404, 'That deck was not found.', 'deck_not_found');
  }

  return db.transaction(async (tx) => {
    /*
     * Locked, so a double-click on Present cannot start two sessions for
     * one deck. The second request waits here, then finds the first one's
     * session below and reuses it.
     */
    const [deck] = await tx
      .select()
      .from(decks)
      .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId), isNull(decks.deletedAt)))
      .for('update');

    if (!deck) throw new HttpError(404, 'That deck was not found.', 'deck_not_found');

    const ordered = orderedSlides(deck.slides);

    if (ordered.length === 0) {
      throw new HttpError(422, 'Add a slide before presenting this deck.', 'deck_empty');
    }

    // Reuse a session that is already live for this deck rather than
    // stranding participants who have already joined the previous one.
    const [existing] = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.deckId, deck.id),
          eq(sessions.ownerId, ownerId),
          inArray(sessions.state, ['live', 'paused']),
        ),
      )
      .limit(1);

    if (existing) return existing;

    const settings = settingsOf(deck.settings);

    const snapshot: DeckSnapshot = {
      title: deck.title,
      slides: ordered.map((s) => ({
        id: s.id,
        kind: s.kind,
        position: s.position,
        config: s.config,
      })),
      theme: { ...themeOf(deck.theme) },
      settings: { ...settings },
    };

    /*
     * The database decides whether a code is free, not a check before the
     * insert: two sessions starting at the same instant could otherwise both
     * see a code as unused. A collision rolls back to a savepoint and tries
     * another code; twelve in a row means a great many sessions are live.
     */
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const session = await tx.transaction(async (savepoint) => {
          const [created] = await savepoint
            .insert(sessions)
            .values({
              id: newId(),
              deckId: deck.id,
              ownerId,
              title: deck.title,
              joinCode: randomJoinCode(),
              joinSlug: newJoinSlug(),
              state: 'live',
              mode: settings.mode,
              deckSnapshot: snapshot,
              currentSlideId: ordered[0]?.id ?? null,
              participationOpen: true,
              resultsVisible: true,
            })
            .returning();

          if (!created) throw new Error('Session insert returned no row');
          return created;
        });

        logger.info(
          { sessionId: session.id, deckId, joinCode: session.joinCode },
          'Session started',
        );
        return session;
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }

    throw new HttpError(503, 'Too many sessions are running. Try again shortly.', 'no_join_code');
  });
}

export async function endSession(sessionId: string, ownerId: string): Promise<Session> {
  const session = await ownedSession(sessionId, ownerId);

  // Ending twice is normal: the presenter's socket and its REST fallback
  // both run, so the second arrives moments after the first.
  if (session.state === 'closed' && session.endedAt) return session;

  /*
   * The first ending is the real one.
   *
   * Retention is measured from this timestamp -- answers are purged a year
   * after a session closed -- so overwriting it on a second call would
   * quietly restart the clock on data that was due to be removed.
   */
  const [ended] = await db
    .update(sessions)
    .set({
      state: 'closed',
      endedAt: sql`COALESCE(${sessions.endedAt}, now())`,
      participationOpen: false,
    })
    .where(eq(sessions.id, session.id))
    .returning();

  logger.info({ sessionId }, 'Session ended');
  return ended ?? session;
}

/** Looks a session up the way a phone does: by the code on screen. */
export async function findByJoinCode(joinCode: string): Promise<Session> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.joinCode, joinCode), inArray(sessions.state, ['live', 'paused'])))
    .limit(1);

  if (!session) {
    throw new HttpError(
      404,
      'No live session has that code. Check the number on screen.',
      'session_not_found',
    );
  }
  return session;
}

/* ------------------------------------------------------------------ */
/* Presenter controls                                                  */
/* ------------------------------------------------------------------ */

/**
 * Shows a slide to the room.
 *
 * A quiz slide's clock starts when the room first sees it, so everyone is
 * scored against the same moment.
 */
export async function goToSlide(session: Session, slideId: string): Promise<Session> {
  const slide = slideOf(session, slideId);
  if (!slide) throw new HttpError(404, 'That slide is not in this deck.', 'slide_not_found');

  const timed = Number(slide.config.countdownSeconds ?? 0) > 0;

  const [updated] = await db
    .update(sessions)
    .set({
      currentSlideId: slideId,
      countdownStartedAt: timed ? new Date() : null,
      countdownSlideId: timed ? slideId : null,
    })
    .where(eq(sessions.id, session.id))
    .returning();

  return updated ?? session;
}

export async function setParticipation(session: Session, open: boolean): Promise<Session> {
  const [updated] = await db
    .update(sessions)
    .set({ participationOpen: open })
    .where(eq(sessions.id, session.id))
    .returning();
  return updated ?? session;
}

export async function setResultsVisible(session: Session, visible: boolean): Promise<Session> {
  const [updated] = await db
    .update(sessions)
    .set({ resultsVisible: visible })
    .where(eq(sessions.id, session.id))
    .returning();
  return updated ?? session;
}

/* ------------------------------------------------------------------ */
/* Snapshot access                                                     */
/* ------------------------------------------------------------------ */

interface SnapshotSlide {
  id: string;
  kind: SlideKind;
  position: number;
  config: Record<string, unknown>;
}

interface Snapshot {
  title: string;
  slides: SnapshotSlide[];
  settings?: Record<string, unknown>;
  /** Frozen with the deck, so a later theme change cannot alter a past run. */
  theme?: Record<string, unknown>;
}

export function snapshotOf(session: Pick<Session, 'deckSnapshot'>): Snapshot {
  const snapshot = session.deckSnapshot as Partial<DeckSnapshot> | null;

  return {
    title: snapshot?.title ?? '',
    slides: (Array.isArray(snapshot?.slides) ? snapshot.slides : []) as SnapshotSlide[],
    ...(snapshot?.settings ? { settings: snapshot.settings } : {}),
    ...(snapshot?.theme ? { theme: snapshot.theme } : {}),
  };
}

/**
 * Whatever text an answer carries, for the profanity check.
 *
 * Only the kinds someone types into. A choice answer carries option ids the
 * author wrote, and running those through a filter would be pointless.
 */
function textOf(payload: unknown): string {
  const data = payload as { text?: unknown; words?: unknown; fields?: unknown };

  if (typeof data.text === 'string') return data.text;

  if (Array.isArray(data.words)) {
    return data.words.filter((word): word is string => typeof word === 'string').join(' ');
  }

  if (data.fields && typeof data.fields === 'object') {
    return Object.values(data.fields as Record<string, unknown>)
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }

  return '';
}

/**
 * Whether people move through the deck themselves.
 *
 * In this mode the presenter's own position is only a starting point;
 * everyone advances at their own speed, which suits a survey left open for
 * a week as much as a workshop where groups work at different rates.
 */
export function isSelfPaced(session: Session): boolean {
  return snapshotOf(session).settings?.mode === 'audience_paced';
}

/** Whether reactions are allowed. On unless the author turned them off. */
export function allowsReactions(session: Session): boolean {
  return snapshotOf(session).settings?.reactions !== false;
}

/**
 * Whether the audience may send questions.
 *
 * Off unless the author asked -- except in a deck that contains a Q&A
 * slide, where the whole point of the slide is to collect questions. A
 * presenter who added one has asked for questions more clearly than any
 * settings toggle could, and a Q&A slide with the Ask button hidden is a
 * blank wall nobody can write on.
 */
export function allowsQuestions(session: Session): boolean {
  const snapshot = snapshotOf(session);
  if (snapshot.settings?.chat === true) return true;
  return snapshot.slides.some((slide) => slide.kind === 'qa');
}

/** The deck's colours, frozen with the session, for the phone to match. */
export function sessionTheme(session: Session): Record<string, unknown> | null {
  return snapshotOf(session).theme ?? null;
}

/**
 * Whether this session should ask people for a name.
 *
 * Derived from the deck rather than read from a setting alone. A quiz
 * produces a leaderboard, and a leaderboard of "Anonymous, Anonymous,
 * Anonymous" is worthless -- so any deck containing a quiz or a leaderboard
 * slide asks, whatever the setting says. A presenter can still turn names
 * on for a non-quiz deck; they cannot accidentally turn them off for one
 * that needs them.
 */
export function collectsNames(session: Session): boolean {
  const snapshot = snapshotOf(session);

  if (snapshot.settings?.collectNames === true) return true;

  return snapshot.slides.some(
    (slide) => slide.kind === 'leaderboard' || definitionFor(slide.kind).isQuiz,
  );
}

export function slideOf(
  session: Pick<Session, 'deckSnapshot'>,
  slideId: string | null,
): SnapshotSlide | null {
  if (!slideId) return null;
  return snapshotOf(session).slides.find((s) => s.id === slideId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Participants                                                        */
/* ------------------------------------------------------------------ */

export async function joinSession(
  session: Session,
  deviceToken: string,
  displayName: string | undefined,
  locale: string | undefined,
): Promise<Participant> {
  const now = new Date();

  const changes = {
    lastSeenAt: now,
    ...(displayName === undefined ? {} : { displayName: displayName.slice(0, 60) }),
    ...(locale === undefined ? {} : { locale: locale.slice(0, 16) }),
  };

  // Upsert on (session, device) so a refresh rejoins rather than creating a
  // second person, which would inflate the count and the one-answer rule.
  const [participant] = await db
    .insert(participants)
    .values({
      id: newId(),
      sessionId: session.id,
      deviceToken,
      firstSeenAt: now,
      ...changes,
    })
    .onConflictDoUpdate({
      target: [participants.sessionId, participants.deviceToken],
      set: changes,
    })
    .returning();

  if (!participant) throw new Error('Participant upsert returned no row');

  if (participant.blockedAt) {
    throw new HttpError(403, 'You have been removed from this session.', 'blocked');
  }

  return participant;
}

export async function countParticipants(sessionId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(participants)
    .where(and(eq(participants.sessionId, sessionId), isNull(participants.blockedAt)));

  return row?.value ?? 0;
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

export interface RecordAnswerInput {
  session: Session;
  participant: Participant;
  slideId: string;
  payload: unknown;
  clientMsgId: string;
}

/**
 * Stores one answer.
 *
 * Returns `duplicate: true` rather than failing when the same clientMsgId
 * arrives twice: a phone that retried after a dropped connection has done
 * nothing wrong, and the answer is already counted.
 */
export async function recordAnswer(
  input: RecordAnswerInput,
): Promise<{ responseId: string; duplicate: boolean }> {
  const { session, participant, slideId, payload, clientMsgId } = input;

  if (!session.participationOpen || session.state !== 'live') {
    throw new HttpError(
      409,
      'This session is not taking answers right now.',
      'participation_closed',
    );
  }

  const slide = slideOf(session, slideId);
  if (!slide) throw new HttpError(404, 'That slide is not in this session.', 'slide_not_found');

  if (!isAnswerable(slide.kind)) {
    throw new HttpError(422, 'That slide does not take answers.', 'not_answerable');
  }

  if (slide.config.participationOpen === false) {
    throw new HttpError(409, 'This question is closed.', 'slide_closed');
  }

  // Validated against the kind's own answer schema, so a crafted payload
  // cannot poison the aggregation the room is watching. The discriminated
  // union picks the right member from the kind we already trust, rather than
  // from anything the client sent.
  const parsed = zAnswer.safeParse({
    ...(payload && typeof payload === 'object' ? payload : {}),
    kind: slide.kind,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(
      422,
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'That answer was not valid.',
      'invalid_answer',
    );
  }

  /*
   * An answer must point at something the slide actually has.
   *
   * The schema checks the shape of an id, not whether it exists -- so a
   * phone still holding a slide whose options were edited, or a crafted
   * payload, could add to the total while matching no option. The room
   * then sees answers arriving with every bar stuck at zero.
   */
  const missing = unknownIds(parsed.data, slide.config);

  if (missing.length > 0) {
    throw new HttpError(
      409,
      'That question has changed. Reload to get the current version.',
      'stale_slide',
    );
  }

  // Checked before anything is stored, so a blocked word never reaches the
  // database and cannot appear even for the instant before a presenter
  // removes it by hand.
  if (snapshotOf(session).settings?.profanityFilter !== false) {
    const text = textOf(parsed.data);

    if (text !== '' && isProfane(text)) {
      throw new HttpError(
        422,
        'That answer contains a word the presenter has blocked.',
        'profanity_blocked',
      );
    }
  }

  const oneAnswerOnly = snapshotOf(session).settings?.oneAnswerPerDevice !== false;

  // Quiz answers are scored as they arrive, against the countdown that was
  // running at that moment. Scoring later, against a clock that has since
  // moved on, would silently change results the room has already seen.
  const elapsedMs = elapsedFor(session, slideId, parsed.data);
  const scored = definitionFor(slide.kind).isQuiz
    ? scoreAnswer({ kind: slide.kind, payload: parsed.data, elapsedMs }, slide.config)
    : null;

  return db.transaction(async (tx) => {
    if (oneAnswerOnly) {
      /*
       * One person, one slide, one answer at a time.
       *
       * Checking for an earlier answer and then inserting is a race: a
       * phone that fires two different answers together would have both
       * pass the check. This lock, held until the transaction ends, makes
       * the second wait for the first and then see it.
       */
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`answer:${participant.id}:${slideId}`}, 0))`,
      );

      const [already] = await tx
        .select({ clientMsgId: responses.clientMsgId })
        .from(responses)
        .where(
          and(
            eq(responses.sessionId, session.id),
            eq(responses.slideId, slideId),
            eq(responses.participantId, participant.id),
            isNull(responses.deletedAt),
          ),
        )
        .limit(1);

      // A resend of the same message is fine; a genuinely new answer is not.
      if (already && already.clientMsgId !== clientMsgId) {
        throw new HttpError(409, 'You have already answered this one.', 'already_answered');
      }
    }

    // The unique index on (session, clientMsgId) is the real guard against a
    // double submit. A retry matches nothing to insert and is reported as the
    // duplicate it is, rather than raised as an error.
    const [inserted] = await tx
      .insert(responses)
      .values({
        id: newId(),
        sessionId: session.id,
        slideId,
        participantId: participant.id,
        kind: slide.kind,
        payload: parsed.data as Record<string, unknown>,
        clientMsgId,
        ...(scored ? { isCorrect: scored.correct, points: scored.points, elapsedMs } : {}),
      })
      .onConflictDoNothing({ target: [responses.sessionId, responses.clientMsgId] })
      .returning({ id: responses.id });

    if (!inserted) {
      const [existing] = await tx
        .select({ id: responses.id })
        .from(responses)
        .where(and(eq(responses.sessionId, session.id), eq(responses.clientMsgId, clientMsgId)));

      return { responseId: existing?.id ?? '', duplicate: true };
    }

    // In the same transaction as the answer, so the counter and the score
    // can never disagree with the rows they summarise.
    await tx
      .update(sessions)
      .set({ responseCount: sql`${sessions.responseCount} + 1` })
      .where(eq(sessions.id, session.id));

    // The running total is kept on the participant so the leaderboard does
    // not have to re-add every answer on every render.
    if (scored && scored.points > 0) {
      await tx
        .update(participants)
        .set({ score: sql`${participants.score} + ${scored.points}` })
        .where(eq(participants.id, participant.id));
    }

    return { responseId: inserted.id, duplicate: false };
  });
}

/** How one stored answer was scored, for the phone that sent it. */
export async function scoreOf(
  responseId: string,
): Promise<{ isCorrect: boolean | null; points: number | null } | null> {
  if (!isId(responseId)) return null;

  const [row] = await db
    .select({ isCorrect: responses.isCorrect, points: responses.points })
    .from(responses)
    .where(eq(responses.id, responseId));

  return row ?? null;
}

/**
 * How long after the countdown started this answer arrived.
 *
 * The phone reports its own elapsed time, which is right when the clock is
 * in sync and wrong when it is not. The server's own measurement is used
 * whenever a countdown is running, because a device clock is something a
 * participant can change.
 */
function elapsedFor(session: Session, slideId: string, payload: unknown): number {
  if (session.countdownSlideId === slideId && session.countdownStartedAt) {
    return Math.max(0, Date.now() - session.countdownStartedAt.getTime());
  }

  const claimed = (payload as { elapsedMs?: unknown }).elapsedMs;
  return typeof claimed === 'number' && Number.isFinite(claimed) && claimed >= 0
    ? Math.min(claimed, 600_000)
    : 0;
}

/* ------------------------------------------------------------------ */
/* Audience questions                                                  */
/* ------------------------------------------------------------------ */

/**
 * Stores a question from the audience.
 *
 * Idempotent on clientMsgId like an answer: a phone that retried gets back
 * the question it already sent, and `duplicate` tells the caller not to
 * announce it to the presenter a second time.
 */
export async function askQuestion(input: {
  session: Session;
  participant: Participant | null;
  participantId: string;
  text: string;
  clientMsgId: string;
}): Promise<{ question: AudienceQuestion; duplicate: boolean }> {
  const [inserted] = await db
    .insert(audienceQuestions)
    .values({
      id: newId(),
      sessionId: input.session.id,
      participantId: input.participantId,
      body: input.text,
      // Copied now so the presenter's queue needs no second lookup, and so it
      // still reads correctly if the participant is removed.
      authorName: input.participant?.displayName ?? '',
      clientMsgId: input.clientMsgId,
    })
    .onConflictDoNothing({ target: [audienceQuestions.sessionId, audienceQuestions.clientMsgId] })
    .returning();

  if (inserted) return { question: inserted, duplicate: false };

  const [existing] = await db
    .select()
    .from(audienceQuestions)
    .where(
      and(
        eq(audienceQuestions.sessionId, input.session.id),
        eq(audienceQuestions.clientMsgId, input.clientMsgId),
      ),
    );

  if (!existing) throw new Error('Question conflict without an existing row');
  return { question: existing, duplicate: true };
}

/* ------------------------------------------------------------------ */
/* Leaderboard                                                         */
/* ------------------------------------------------------------------ */

/** Standings for a session, newest scores first. */
export async function leaderboardFor(
  session: Session,
  previous?: Map<string, number>,
): Promise<LeaderboardEntry[]> {
  const rows = await db
    .select({
      participantId: responses.participantId,
      points: responses.points,
      isCorrect: responses.isCorrect,
      elapsedMs: responses.elapsedMs,
      slideId: responses.slideId,
    })
    .from(responses)
    .where(
      and(
        eq(responses.sessionId, session.id),
        isNull(responses.deletedAt),
        isNotNull(responses.points),
      ),
    );

  if (rows.length === 0) return [];

  // One lookup for every name, rather than one per row.
  const people = await db
    .select({ id: participants.id, displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.sessionId, session.id));

  const names = new Map(people.map((p) => [p.id, p.displayName]));

  // Slide order, so a streak means consecutive questions rather than
  // whichever answers happened to arrive together.
  const order = new Map(snapshotOf(session).slides.map((slide, index) => [slide.id, index]));

  return buildLeaderboard(
    rows.map((row) => ({
      participantId: row.participantId,
      displayName: names.get(row.participantId) ?? '',
      points: row.points ?? 0,
      correct: row.isCorrect === true,
      elapsedMs: row.elapsedMs ?? undefined,
      slideIndex: order.get(row.slideId),
    })),
    previous,
  );
}

/**
 * One person's score and where it places them.
 *
 * Answering a quiz used to build the whole leaderboard to tell one phone
 * its own rank -- every answer reading every scored answer in the room, so
 * a hall of four hundred did that four hundred times. This asks the
 * database the question directly instead: one row, two numbers.
 */
export async function standingOf(
  session: Session,
  participantId: string,
): Promise<{ score: number; rank: number | null }> {
  if (!isId(participantId)) return { score: 0, rank: null };

  const [row] = await db
    .execute<{ score: number; rank: number }>(
      sql`
    WITH totals AS (
      SELECT participant_id, COALESCE(sum(points), 0) AS score
      FROM responses
      WHERE session_id = ${session.id} AND deleted_at IS NULL AND points IS NOT NULL
      GROUP BY participant_id
    )
    SELECT score::double precision AS score, rank::int AS rank
    FROM (SELECT participant_id, score, rank() OVER (ORDER BY score DESC) AS rank FROM totals) ranked
    WHERE participant_id = ${participantId}
  `,
    )
    .then((result) => result.rows);

  return row ? { score: row.score, rank: row.rank } : { score: 0, rank: null };
}

export async function removeResponse(
  sessionId: string,
  ownerId: string,
  responseId: string,
): Promise<{ slideId: string }> {
  const session = await ownedSession(sessionId, ownerId);

  const notFound = () => new HttpError(404, 'That answer was not found.', 'response_not_found');
  if (!isId(responseId)) throw notFound();

  // Soft delete: aggregates skip it, but the record of what was said stays.
  const [removed] = await db
    .update(responses)
    .set({ deletedAt: new Date(), deletedReason: 'presenter' })
    .where(
      and(
        eq(responses.id, responseId),
        eq(responses.sessionId, session.id),
        isNull(responses.deletedAt),
      ),
    )
    .returning({ slideId: responses.slideId });

  if (!removed) throw notFound();
  return { slideId: removed.slideId };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/** Live answers to one slide, oldest first. */
export function liveAnswers(sessionId: string, slideId: string) {
  return db
    .select({ id: responses.id, payload: responses.payload, upvotes: responses.upvotes })
    .from(responses)
    .where(
      and(
        eq(responses.sessionId, sessionId),
        eq(responses.slideId, slideId),
        isNull(responses.deletedAt),
      ),
    )
    .orderBy(asc(responses.submittedAt));
}

export async function resultsFor(session: Session, slideId: string): Promise<SlideResults | null> {
  const slide = slideOf(session, slideId);
  if (!slide) return null;

  const rows = await liveAnswers(session.id, slideId);

  const data = aggregate(
    slide.kind,
    rows.map((r) => ({ id: r.id, payload: r.payload, upvotes: r.upvotes })),
    slide.config,
  );

  return { slideId, kind: slide.kind, count: rows.length, data };
}

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

export function toSessionState(session: Session, participantCount: number): SessionState {
  const countdownEndsAt = (() => {
    if (!session.countdownStartedAt || !session.countdownSlideId) return null;
    const slide = slideOf(session, session.countdownSlideId);
    const seconds = Number(slide?.config.countdownSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(session.countdownStartedAt.getTime() + seconds * 1000).toISOString();
  })();

  return {
    sessionId: session.id,
    state: session.state,
    currentSlideId: session.currentSlideId,
    participationOpen: session.participationOpen,
    resultsVisible: session.resultsVisible,
    participantCount,
    countdownEndsAt,
  };
}

/**
 * The current slide as a phone needs it.
 *
 * Quiz slides have their correct answers stripped: sending them to a phone
 * would let anyone with developer tools read the answer off the wire.
 */
export async function participantSlideOf(
  session: Session,
  participantId: string,
): Promise<ParticipantSlide | null> {
  const selfPaced = isSelfPaced(session);

  // In a self-paced session each person has their own position; otherwise
  // everyone is wherever the presenter is.
  let slideId = session.currentSlideId;

  if (selfPaced) {
    const participant = await getParticipant(participantId);
    slideId = participant?.currentSlideId ?? session.currentSlideId;
  }

  const slide = slideOf(session, slideId);
  if (!slide) return null;

  const slides = snapshotOf(session).slides;
  const index = slides.findIndex((s) => s.id === slide.id);

  const [answered] = isId(participantId)
    ? await db
        .select({ id: responses.id })
        .from(responses)
        .where(
          and(
            eq(responses.sessionId, session.id),
            eq(responses.slideId, slide.id),
            eq(responses.participantId, participantId),
            isNull(responses.deletedAt),
          ),
        )
        .limit(1)
    : [];

  return {
    id: slide.id,
    kind: slide.kind,
    config: stripAnswers(slide.kind, slide.config),
    answered: answered !== undefined,
    index: index === -1 ? 0 : index,
    total: slides.length,
    selfPaced,
  };
}

/**
 * The slide payload for a whole room at once.
 *
 * Telling everyone to move used to ask the database about each phone in
 * turn -- a query per person, so a hall of four hundred meant four hundred
 * round trips before the last of them saw the question. Only `answered`
 * differs between people, so that is the only thing worth asking per
 * person, and it is one query for all of them.
 *
 * Returns a function rather than a map so the caller reads it per socket
 * exactly as it did before.
 */
export async function participantSlidesFor(
  session: Session,
  participantIds: string[],
): Promise<(participantId: string) => ParticipantSlide | null> {
  const selfPaced = isSelfPaced(session);
  const slides = snapshotOf(session).slides;

  /*
   * A self-paced room is the one case where people are genuinely looking
   * at different slides, so their positions are read together too.
   */
  const positions = new Map<string, string | null>();

  if (selfPaced && participantIds.length > 0) {
    const rows = await db
      .select({ id: participants.id, currentSlideId: participants.currentSlideId })
      .from(participants)
      .where(inArray(participants.id, participantIds));

    for (const row of rows) positions.set(row.id, row.currentSlideId);
  }

  const slideIds = selfPaced
    ? [...new Set([...positions.values(), session.currentSlideId].filter((id) => id !== null))]
    : session.currentSlideId
      ? [session.currentSlideId]
      : [];

  // Who has already answered each slide anyone is looking at.
  const answered = new Set<string>();

  if (slideIds.length > 0 && participantIds.length > 0) {
    const rows = await db
      .select({ participantId: responses.participantId, slideId: responses.slideId })
      .from(responses)
      .where(
        and(
          eq(responses.sessionId, session.id),
          inArray(responses.slideId, slideIds),
          inArray(responses.participantId, participantIds),
          isNull(responses.deletedAt),
        ),
      );

    for (const row of rows) answered.add(`${row.participantId}:${row.slideId}`);
  }

  return (participantId) => {
    const slideId = selfPaced
      ? (positions.get(participantId) ?? session.currentSlideId)
      : session.currentSlideId;

    const slide = slideOf(session, slideId);
    if (!slide) return null;

    const index = slides.findIndex((s) => s.id === slide.id);

    return {
      id: slide.id,
      kind: slide.kind,
      config: stripAnswers(slide.kind, slide.config),
      answered: answered.has(`${participantId}:${slide.id}`),
      index: index === -1 ? 0 : index,
      total: slides.length,
      selfPaced,
    };
  };
}

/**
 * Moves one participant through a self-paced deck.
 *
 * Refused when the presenter is driving: everyone follows one screen there,
 * and a phone that could move itself would be answering a different
 * question from the one on the wall.
 */
export async function moveParticipant(
  session: Session,
  participantId: string,
  direction: 'next' | 'previous',
): Promise<ParticipantSlide | null> {
  if (!isSelfPaced(session)) {
    throw new HttpError(409, 'The presenter is leading this session.', 'not_self_paced');
  }

  const participant = await getParticipant(participantId);
  if (!participant) {
    throw new HttpError(404, 'You are not in this session.', 'participant_not_found');
  }

  const slides = snapshotOf(session).slides;
  const currentId = participant.currentSlideId ?? session.currentSlideId ?? slides[0]?.id ?? null;
  const current = slides.findIndex((s) => s.id === currentId);

  // Skipped slides are stepped over rather than shown as a blank screen.
  const step = direction === 'next' ? 1 : -1;
  let target = (current === -1 ? 0 : current) + step;

  while (target >= 0 && target < slides.length && slides[target]?.config.skipped === true) {
    target += step;
  }

  // Clamped rather than wrapped: reaching the end should stay at the end,
  // not silently return someone to the first question.
  if (target < 0 || target >= slides.length) {
    return participantSlideOf(session, participantId);
  }

  await db
    .update(participants)
    .set({ currentSlideId: slides[target]?.id ?? null, lastSeenAt: new Date() })
    .where(eq(participants.id, participant.id));

  return participantSlideOf(session, participantId);
}

/** Removes anything that would give away a quiz answer. */
function stripAnswers(kind: SlideKind, config: Record<string, unknown>): Record<string, unknown> {
  if (!definitionFor(kind).isQuiz) return config;

  const clean: Record<string, unknown> = { ...config };

  if (Array.isArray(clean.options)) {
    clean.options = (clean.options as Record<string, unknown>[]).map((option) => {
      const { correct: _correct, ...rest } = option;
      return rest;
    });
  }

  delete clean.correctOrder;
  delete clean.correctText;
  delete clean.acceptedAnswers;
  delete clean.pairs;

  return clean;
}
