import { randomInt, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import {
  Session,
  Participant,
  Response,
  Deck,
  type SessionDoc,
  type ParticipantDoc,
} from '../models/index.js';
import { HttpError } from '../app.js';
import { logger } from '../lib/logger.js';
import { isProfane } from './profanity.js';
import {
  aggregate,
  definitionFor,
  isAnswerable,
  scoreAnswer,
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

/* ------------------------------------------------------------------ */
/* Join codes                                                          */
/* ------------------------------------------------------------------ */

/**
 * Six digits, random rather than sequential.
 *
 * Sequential codes would let anyone who joined one session guess the next.
 * Uniqueness is only enforced among sessions that are currently joinable,
 * so the space is never exhausted however many sessions have ever run.
 */
async function allocateJoinCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    const taken = await Session.exists({
      joinCode: code,
      state: { $in: ['scheduled', 'live', 'paused'] },
    });

    if (!taken) return code;
  }

  // Twelve collisions in a row means a great many sessions are live at once.
  throw new HttpError(503, 'Too many sessions are running. Try again shortly.', 'no_join_code');
}

/**
 * A subdocument as plain values.
 *
 * Mongoose types these paths as plain objects but returns subdocuments at
 * runtime, so a spread copies internal fields instead of the data.
 */
function toPlain<T>(value: T): T {
  const candidate = value as { toObject?: () => T };
  return typeof candidate.toObject === 'function' ? candidate.toObject() : { ...value };
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
/* Starting and ending                                                 */
/* ------------------------------------------------------------------ */

export async function startSession(deckId: string, ownerId: string): Promise<SessionDoc> {
  if (!Types.ObjectId.isValid(deckId)) {
    throw new HttpError(404, 'That deck was not found.', 'deck_not_found');
  }

  const deck = await Deck.findOne({ _id: deckId, ownerId, deletedAt: null });
  if (!deck) throw new HttpError(404, 'That deck was not found.', 'deck_not_found');

  if (deck.slides.length === 0) {
    throw new HttpError(422, 'Add a slide before presenting this deck.', 'deck_empty');
  }

  // Reuse a session that is already live for this deck rather than stranding
  // participants who have already joined the previous one.
  const existing = await Session.findOne({
    deckId: deck._id,
    ownerId,
    state: { $in: ['live', 'paused'] },
  });
  if (existing) return existing;

  // config is Schema.Types.Mixed, which Mongoose types as `any`; it was
  // validated by the kind's Zod schema on the way in, so the shape is known
  // even though the type system cannot see it.
  const ordered = (
    deck.slides.slice() as { id: string; kind: SlideKind; position: number; config: unknown }[]
  )
    .sort((a, b) => a.position - b.position)
    .map((s) => ({ id: s.id, kind: s.kind, position: s.position, config: s.config }));

  const session = await Session.create({
    deckId: deck._id,
    ownerId,
    title: deck.title,
    joinCode: await allocateJoinCode(),
    joinSlug: newJoinSlug(),
    state: 'live',
    mode: deck.settings?.mode ?? 'presenter_paced',
    deckSnapshot: {
      title: deck.title,
      slides: ordered,
      // toObject, not a spread: spreading a Mongoose subdocument stores its
      // internals rather than its values, which froze a useless theme into
      // every snapshot.
      theme: toPlain(deck.theme),
      settings: deck.settings,
    },
    currentSlideId: ordered[0]?.id ?? null,
    participationOpen: true,
    resultsVisible: true,
  });

  logger.info(
    { sessionId: session._id.toString(), deckId, joinCode: session.joinCode },
    'Session started',
  );
  return session;
}

export async function endSession(sessionId: string, ownerId: string): Promise<SessionDoc> {
  const session = await ownedSession(sessionId, ownerId);

  session.state = 'closed';
  session.endedAt = new Date();
  session.participationOpen = false;
  await session.save();

  logger.info({ sessionId }, 'Session ended');
  return session;
}

async function ownedSession(sessionId: string, ownerId: string): Promise<SessionDoc> {
  if (!Types.ObjectId.isValid(sessionId)) {
    throw new HttpError(404, 'That session was not found.', 'session_not_found');
  }
  const session = await Session.findOne({ _id: sessionId, ownerId });
  if (!session) throw new HttpError(404, 'That session was not found.', 'session_not_found');
  return session;
}

/** Looks a session up the way a phone does: by the code on screen. */
export async function findByJoinCode(joinCode: string): Promise<SessionDoc> {
  const session = await Session.findOne({
    joinCode,
    state: { $in: ['live', 'paused'] },
  });

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

export function snapshotOf(session: SessionDoc): Snapshot {
  return session.deckSnapshot as Snapshot;
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

/** Whether reactions are allowed. On unless the author turned them off. */
export function allowsReactions(session: SessionDoc): boolean {
  return snapshotOf(session).settings?.reactions !== false;
}

/** Whether the audience may send questions. Off unless the author asked. */
export function allowsQuestions(session: SessionDoc): boolean {
  return snapshotOf(session).settings?.chat === true;
}

/**
 * Whether this session should ask people for a name.
 *
 * Derived from the deck rather than read from a setting alone. A quiz
 * produces a leaderboard, and a leaderboard of "Anonymous, Anonymous,
 * Anonymous" is worthless — so any deck containing a quiz or a leaderboard
 * slide asks, whatever the setting says. A presenter can still turn names
 * on for a non-quiz deck; they cannot accidentally turn them off for one
 * that needs them.
 */
export function collectsNames(session: SessionDoc): boolean {
  const snapshot = snapshotOf(session);

  if (snapshot.settings?.collectNames === true) return true;

  return snapshot.slides.some(
    (slide) => slide.kind === 'leaderboard' || definitionFor(slide.kind).isQuiz,
  );
}

export function slideOf(session: SessionDoc, slideId: string | null): SnapshotSlide | null {
  if (!slideId) return null;
  return snapshotOf(session).slides.find((s) => s.id === slideId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Participants                                                        */
/* ------------------------------------------------------------------ */

export async function joinSession(
  session: SessionDoc,
  deviceToken: string,
  displayName: string | undefined,
  locale: string | undefined,
): Promise<ParticipantDoc> {
  // Upsert on (session, device) so a refresh rejoins rather than creating a
  // second person, which would inflate the count and the one-answer rule.
  const participant = await Participant.findOneAndUpdate(
    { sessionId: session._id, deviceToken },
    {
      $setOnInsert: { sessionId: session._id, deviceToken, firstSeenAt: new Date() },
      $set: {
        lastSeenAt: new Date(),
        ...(displayName === undefined ? {} : { displayName: displayName.slice(0, 60) }),
        ...(locale === undefined ? {} : { locale: locale.slice(0, 16) }),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  if (participant.blockedAt) {
    throw new HttpError(403, 'You have been removed from this session.', 'blocked');
  }

  return participant;
}

export async function countParticipants(sessionId: Types.ObjectId): Promise<number> {
  return Participant.countDocuments({ sessionId, blockedAt: null });
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

export interface RecordAnswerInput {
  session: SessionDoc;
  participant: ParticipantDoc;
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

  if (oneAnswerOnly) {
    const already = await Response.findOne({
      sessionId: session._id,
      slideId,
      participantId: participant._id,
      deletedAt: null,
    });

    // A resend of the same message is fine; a genuinely new answer is not.
    if (already && already.clientMsgId !== clientMsgId) {
      throw new HttpError(409, 'You have already answered this one.', 'already_answered');
    }
  }

  // Quiz answers are scored as they arrive, against the countdown that was
  // running at that moment. Scoring later, against a clock that has since
  // moved on, would silently change results the room has already seen.
  const scored = definitionFor(slide.kind).isQuiz
    ? scoreAnswer(
        {
          kind: slide.kind,
          payload: parsed.data,
          elapsedMs: elapsedFor(session, slideId, parsed.data),
        },
        slide.config,
      )
    : null;

  try {
    const response = await Response.create({
      sessionId: session._id,
      slideId,
      participantId: participant._id,
      kind: slide.kind,
      payload: parsed.data,
      clientMsgId,
      ...(scored
        ? {
            isCorrect: scored.correct,
            points: scored.points,
            elapsedMs: elapsedFor(session, slideId, parsed.data),
          }
        : {}),
    });

    await Session.updateOne({ _id: session._id }, { $inc: { 'stats.responseCount': 1 } });

    // The running total is kept on the participant so the leaderboard does
    // not have to re-add every answer on every render.
    if (scored && scored.points > 0) {
      await Participant.updateOne({ _id: participant._id }, { $inc: { score: scored.points } });
    }

    return { responseId: response._id.toString(), duplicate: false };
  } catch (err) {
    // The unique index on (sessionId, clientMsgId) is the real guard against
    // a double submit; two retries racing both reach here.
    if (isDuplicateKey(err)) {
      const existing = await Response.findOne({ sessionId: session._id, clientMsgId });
      return { responseId: existing?._id.toString() ?? '', duplicate: true };
    }
    throw err;
  }
}

/**
 * How long after the countdown started this answer arrived.
 *
 * The phone reports its own elapsed time, which is right when the clock is
 * in sync and wrong when it is not. The server's own measurement is used
 * whenever a countdown is running, because a device clock is something a
 * participant can change.
 */
function elapsedFor(session: SessionDoc, slideId: string, payload: unknown): number {
  if (session.countdownSlideId === slideId && session.countdownStartedAt) {
    return Math.max(0, Date.now() - session.countdownStartedAt.getTime());
  }

  const claimed = (payload as { elapsedMs?: unknown }).elapsedMs;
  return typeof claimed === 'number' && Number.isFinite(claimed) && claimed >= 0
    ? Math.min(claimed, 600_000)
    : 0;
}

/* ------------------------------------------------------------------ */
/* Leaderboard                                                         */
/* ------------------------------------------------------------------ */

/** Standings for a session, newest scores first. */
export async function leaderboardFor(
  session: SessionDoc,
  previous?: Map<string, number>,
): Promise<LeaderboardEntry[]> {
  const rows = await Response.find({
    sessionId: session._id,
    deletedAt: null,
    points: { $ne: null },
  })
    .select('participantId points isCorrect')
    .lean();

  if (rows.length === 0) return [];

  // One lookup for every name, rather than a populate per row.
  const participants = await Participant.find({ sessionId: session._id })
    .select('displayName')
    .lean();

  const names = new Map(participants.map((p) => [p._id.toString(), p.displayName]));

  return buildLeaderboard(
    rows.map((row) => {
      const id = (row.participantId as Types.ObjectId).toString();
      return {
        participantId: id,
        displayName: names.get(id) ?? '',
        points: row.points ?? 0,
        correct: row.isCorrect === true,
      };
    }),
    previous,
  );
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export async function removeResponse(
  sessionId: string,
  ownerId: string,
  responseId: string,
): Promise<{ slideId: string }> {
  const session = await ownedSession(sessionId, ownerId);

  if (!Types.ObjectId.isValid(responseId)) {
    throw new HttpError(404, 'That answer was not found.', 'response_not_found');
  }

  // Soft delete: aggregates skip it, but the record of what was said stays.
  const response = await Response.findOneAndUpdate(
    { _id: responseId, sessionId: session._id, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedReason: 'presenter' } },
    { new: true },
  );

  if (!response) throw new HttpError(404, 'That answer was not found.', 'response_not_found');
  return { slideId: response.slideId };
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

export async function resultsFor(
  session: SessionDoc,
  slideId: string,
): Promise<SlideResults | null> {
  const slide = slideOf(session, slideId);
  if (!slide) return null;

  const rows = await Response.find({ sessionId: session._id, slideId, deletedAt: null })
    .select('payload upvotes')
    .lean();

  const data = aggregate(
    slide.kind,
    rows.map((r) => ({
      id: r._id.toString(),
      // Mixed again: validated on write, opaque to the type system on read.
      payload: r.payload as unknown,
      upvotes: r.upvotes,
    })),
    slide.config,
  );

  return { slideId, kind: slide.kind, count: rows.length, data };
}

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

export function toSessionState(session: SessionDoc, participantCount: number): SessionState {
  const countdownEndsAt = (() => {
    if (!session.countdownStartedAt || !session.countdownSlideId) return null;
    const slide = slideOf(session, session.countdownSlideId);
    const seconds = Number(slide?.config.countdownSeconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(session.countdownStartedAt.getTime() + seconds * 1000).toISOString();
  })();

  return {
    sessionId: session._id.toString(),
    state: session.state,
    // The schema defaults this to null, but Mongoose types an optional
    // path as possibly undefined; the wire format has only null.
    currentSlideId: session.currentSlideId ?? null,
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
  session: SessionDoc,
  participantId: Types.ObjectId,
): Promise<ParticipantSlide | null> {
  const slide = slideOf(session, session.currentSlideId ?? null);
  if (!slide) return null;

  const answered = await Response.exists({
    sessionId: session._id,
    slideId: slide.id,
    participantId,
    deletedAt: null,
  });

  return {
    id: slide.id,
    kind: slide.kind,
    config: stripAnswers(slide.kind, slide.config),
    answered: answered !== null,
  };
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
