import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { isProduction, isAllowedOrigin } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { isId } from '../db/ids.js';
import { users, type Session } from '../db/schema.js';
import { HttpError } from '../app.js';
import * as sessions from '../services/sessions.js';
import { isProfane } from '../services/profanity.js';
import {
  definitionFor,
  room,
  zParticipantJoin,
  zSubmitAnswer,
  zPresenterJoin,
  zGoToSlide,
  zSetParticipation,
  zSetResultsVisible,
  zRemoveResponse,
  zAskQuestion,
  zReaction,
  zParticipantMove,
  type ServerEvents,
  type ClientEvents,
  type AckResult,
  type JoinResult,
} from '@pulse/shared';

/**
 * The realtime layer.
 *
 * Two kinds of client share one server but never share a room. Presenters
 * are authenticated and can control the session; participants are anonymous
 * and can only answer. Nothing presenter-only is ever emitted to a phone,
 * because the phone is not in the room it would be sent to.
 */

/** What a socket has proved about itself. Set on join, read on every event. */
export interface SocketContext {
  sessionId?: string;
  participantId?: string;
  /** Set only for an authenticated presenter who owns the session. */
  ownerId?: string;
}

// Held on socket.data rather than in a side table, because that is the only
// per-socket state visible through fetchSockets() — which broadcastSlide
// needs in order to send each phone its own view of the current slide.
type Sock = Socket<ClientEvents, ServerEvents, Record<string, never>, SocketContext>;

function contextOf(socket: Sock): SocketContext {
  return socket.data;
}

/** Turns a thrown error into an ack the client can show a person. */
function toAck(err: unknown): AckResult {
  if (err instanceof HttpError) {
    return { ok: false, code: err.code, message: err.message };
  }
  logger.error({ err }, 'Unexpected realtime error');
  return { ok: false, code: 'internal', message: 'Something went wrong.' };
}

/**
 * A simple per-socket rate limit.
 *
 * A phone that answers honestly sends a handful of events per minute. This
 * exists so one misbehaving client cannot flood a room, and it is per socket
 * rather than per IP because a lecture hall shares one IP.
 */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

/** The socket server, with this product's own event names on it. */
type GatewayServer = Server<ClientEvents, ServerEvents, Record<string, never>, SocketContext>;

/**
 * Sends at most one of a thing every so often.
 *
 * A lecture hall answers together: two hundred people look up at the same
 * question and tap within a few seconds. Recomputing the tally and the
 * standings for every one of those answers, and broadcasting each, is work
 * that grows with the square of the room -- four hundred students meant
 * four hundred leaderboards of four hundred entries, a hundred and sixty
 * thousand rows serialised into one burst, while everyone waits.
 *
 * Nobody can read four hundred updates a second anyway. The first one goes
 * out immediately, so a quiet room still feels instant, and the rest are
 * collapsed into one at the end of each window -- the last of which always
 * runs, so the final figures are never the second-to-last ones.
 */
class Coalescer {
  private readonly pending = new Map<string, () => Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly windowMs: number) {}

  /** Runs `work` now if this key is idle, otherwise at the end of the window. */
  run(key: string, work: () => Promise<void>): void {
    if (this.timers.has(key)) {
      // Something is already scheduled: keep only the newest work, since
      // each run reads the current state and supersedes the last.
      this.pending.set(key, work);
      return;
    }

    void this.fire(key, work);

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const queued = this.pending.get(key);
        this.pending.delete(key);
        if (queued) this.run(key, queued);
      }, this.windowMs),
    );
  }

  private async fire(key: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      // A failed broadcast must not take the socket down with it; the next
      // answer schedules another.
      logger.error({ err, key }, 'Broadcast failed');
    }
  }

  /** Stops every pending run. Used when the process is shutting down. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}

/*
 * A tally can move several times a second without anyone minding; the
 * standings are a bigger payload and a slower read, so they move less
 * often. Both are well inside what reads as live in a room.
 */
const resultsBroadcast = new Coalescer(150);
const leaderboardBroadcast = new Coalescer(400);

/*
 * The head count moves fastest of all: a lecture hall does not trickle in,
 * it arrives in the thirty seconds after the code goes up on the screen.
 * Sent per arrival it is quadratic in the worst possible place -- eight
 * hundred students joining meant six hundred and forty thousand messages,
 * each one redrawing a number on every phone in the room, and the last
 * person to join waited seven seconds for it.
 *
 * A quarter second is below what anyone notices in a number ticking up.
 */
const countBroadcast = new Coalescer(250);

/** Sends the current head count to the room, at most every so often. */
function announceCount(io: GatewayServer, sessionId: string): void {
  countBroadcast.run(sessionId, async () => {
    // Read inside the run, so the figure sent is the one that is true
    // when it is sent rather than when it was scheduled.
    const count = await sessions.countParticipants(sessionId);
    io.to(room.presenters(sessionId))
      .to(room.participants(sessionId))
      .emit('participants:count', { count });
  });
}

const answerLimit = new RateLimiter(30, 60_000);
const reactionLimit = new RateLimiter(20, 10_000);
const joinLimit = new RateLimiter(10, 60_000);

export function attachRealtime(httpServer: HttpServer): GatewayServer {
  const io = new Server<ClientEvents, ServerEvents, Record<string, never>, SocketContext>(
    httpServer,
    {
      cors: {
        // Same rule as the REST API, so a phone that can load the join
        // app can also open its socket.
        origin: (origin, callback) => {
          if (!origin || isAllowedOrigin(origin)) callback(null, true);
          else callback(new Error('Origin not allowed'));
        },
        credentials: true,
      },
      // A phone on mobile data drops often; this keeps a reconnect cheap.
      pingInterval: 25_000,
      pingTimeout: 20_000,
      // Payloads are small. A large one is a mistake or an attack.
      maxHttpBufferSize: 256 * 1024,
      transports: ['websocket', 'polling'],
    },
  );

  io.on('connection', (socket: Sock) => {
    const context = contextOf(socket);

    /* ---------------- participants ---------------- */

    socket.on('participant:join', (raw, ack) => {
      void (async () => {
        try {
          if (!joinLimit.allow(socket.id)) {
            ack({ ok: false, code: 'rate_limited', message: 'Too many attempts. Wait a moment.' });
            return;
          }

          const input = zParticipantJoin.parse(raw);
          const session = await sessions.findByJoinCode(input.joinCode);

          const participant = await sessions.joinSession(
            session,
            input.deviceToken,
            input.displayName,
            input.locale,
          );

          context.sessionId = session.id;
          context.participantId = participant.id;

          await socket.join(room.participants(context.sessionId));

          const count = await sessions.countParticipants(session.id);
          const slide = await sessions.participantSlideOf(session, participant.id);

          const result: JoinResult = {
            ok: true,
            participantId: context.participantId,
            session: sessions.toSessionState(session, count),
            slide,
            displayName: participant.displayName,
            collectNames: sessions.collectsNames(session),
            theme: sessions.sessionTheme(session),
            allowReactions: sessions.allowsReactions(session),
            allowQuestions: sessions.allowsQuestions(session),
          };
          ack(result);

          // Everyone watching sees the room fill up. The joiner already has
          // the figure in their own acknowledgement, so nobody waits on this.
          announceCount(io, context.sessionId);
        } catch (err) {
          ack(toAck(err) as JoinResult);
        }
      })();
    });

    socket.on('participant:answer', (raw, ack) => {
      void (async () => {
        try {
          const { sessionId, participantId } = context;
          if (!sessionId || !participantId) {
            ack({ ok: false, code: 'not_joined', message: 'Join the session first.' });
            return;
          }

          if (!answerLimit.allow(socket.id)) {
            ack({ ok: false, code: 'rate_limited', message: 'Slow down a moment.' });
            return;
          }

          const input = zSubmitAnswer.parse(raw);

          const session = await sessions.getSession(sessionId);
          const participant = await sessions.getParticipant(participantId);
          if (!session || !participant) {
            ack({ ok: false, code: 'session_not_found', message: 'That session has ended.' });
            return;
          }

          const { responseId, duplicate } = await sessions.recordAnswer({
            session,
            participant,
            slideId: input.slideId,
            payload: input.payload,
            clientMsgId: input.clientMsgId,
          });

          ack({ ok: true });

          // A retry is already counted; broadcasting again would double it
          // on every presenter screen.
          if (duplicate) return;

          /*
           * The tally is recomputed on a schedule rather than per answer.
           * Every answer is still counted -- the next run reads the
           * database, so it includes everything that arrived meanwhile.
           */
          resultsBroadcast.run(`${sessionId}:${input.slideId}`, async () => {
            const current = await sessions.getSession(sessionId);
            if (!current) return;

            const results = await sessions.resultsFor(current, input.slideId);
            if (!results) return;

            io.to(room.presenters(sessionId)).emit('results:update', results);

            const settings = sessions.snapshotOf(current).settings ?? {};
            if (settings.showResultsToParticipants === true) {
              io.to(room.participants(sessionId)).emit('results:update', results);
            }
          });

          io.to(room.presenters(sessionId)).emit('response:new', {
            slideId: input.slideId,
            responseId,
            payload: input.payload,
            displayName: participant.displayName,
          });

          // Quiz slides carry a score, so the standings move on every answer.
          const slide = sessions.slideOf(session, input.slideId);

          if (slide && definitionFor(slide.kind).isQuiz) {
            leaderboardBroadcast.run(sessionId, async () => {
              const current = await sessions.getSession(sessionId);
              if (!current) return;

              const entries = await sessions.leaderboardFor(current);
              io.to(room.presenters(sessionId)).emit('leaderboard:update', { entries });
            });

            /*
             * This phone's own result is not coalesced: it is one small
             * message to one person who is waiting to see whether they got
             * it right, and it costs nothing to send immediately.
             */
            const stored = await sessions.scoreOf(responseId);
            const standing = await sessions.standingOf(session, participantId);

            socket.emit('quiz:result', {
              slideId: input.slideId,
              correct: stored?.isCorrect === true,
              points: stored?.points ?? 0,
              totalScore: standing.score,
              rank: standing.rank,
            });
          }
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('participant:question', (raw, ack) => {
      void (async () => {
        try {
          const { sessionId, participantId } = context;
          if (!sessionId || !participantId) {
            ack({ ok: false, code: 'not_joined', message: 'Join the session first.' });
            return;
          }
          if (!answerLimit.allow(socket.id)) {
            ack({ ok: false, code: 'rate_limited', message: 'Slow down a moment.' });
            return;
          }

          const input = zAskQuestion.parse(raw);

          const questionSession = await sessions.getSession(sessionId);
          if (!questionSession) {
            ack({ ok: false, code: 'session_not_found', message: 'That session has ended.' });
            return;
          }

          // Enforced here rather than only by hiding the button: a phone can
          // emit whatever event it likes.
          if (!sessions.allowsQuestions(questionSession)) {
            ack({
              ok: false,
              code: 'questions_disabled',
              message: 'The presenter has turned questions off.',
            });
            return;
          }

          if (isProfane(input.text)) {
            ack({
              ok: false,
              code: 'profanity_blocked',
              message: 'That question contains a word the presenter has blocked.',
            });
            return;
          }
          const participant = await sessions.getParticipant(participantId);

          const { question, duplicate } = await sessions.askQuestion({
            session: questionSession,
            participant,
            participantId,
            text: input.text,
            clientMsgId: input.clientMsgId,
          });

          ack({ ok: true });

          // A repeated clientMsgId means the phone retried; it is already on
          // the presenter's screen and must not appear there twice.
          if (duplicate) return;

          io.to(room.presenters(sessionId)).emit('question:new', {
            id: question.id,
            text: question.body,
            displayName: question.authorName,
            upvotes: 0,
          });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('participant:leaderboard', (ack) => {
      void (async () => {
        try {
          const { sessionId, participantId } = context;
          if (!sessionId || !participantId) {
            ack({ ok: false, code: 'not_joined', message: 'Join the session first.' });
            return;
          }

          const session = await sessions.getSession(sessionId);
          if (!session) {
            ack({ ok: false, code: 'session_not_found', message: 'That session has ended.' });
            return;
          }

          const entries = await sessions.leaderboardFor(session);
          // The caller's own id comes back so their row can be highlighted
          // without the phone having to know who it is.
          ack({ ok: true, entries, you: participantId });
        } catch {
          ack({ ok: false, code: 'internal', message: 'Something went wrong.' });
        }
      })();
    });

    socket.on('participant:move', (raw, ack) => {
      void (async () => {
        try {
          const { sessionId, participantId } = context;
          if (!sessionId || !participantId) {
            ack({ ok: false, code: 'not_joined', message: 'Join the session first.' });
            return;
          }

          const input = zParticipantMove.parse(raw);
          const session = await sessions.getSession(sessionId);

          if (!session) {
            ack({ ok: false, code: 'session_not_found', message: 'That session has ended.' });
            return;
          }

          const slide = await sessions.moveParticipant(session, participantId, input.direction);

          // Only to this socket: in a self-paced session everyone is
          // somewhere different, and broadcasting would drag the room along.
          socket.emit('slide:show', slide);
          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('participant:reaction', (raw) => {
      const { sessionId } = context;
      if (!sessionId) return;
      if (!reactionLimit.allow(socket.id)) return;

      const parsed = zReaction.safeParse(raw);
      if (!parsed.success) return;

      void (async () => {
        // Checked on the server as well as hidden in the interface: a phone
        // can emit whatever event it likes.
        const reactionSession = await sessions.getSession(sessionId);
        if (!reactionSession || !sessions.allowsReactions(reactionSession)) return;

        // Ephemeral by design: never stored, just shown. Sent to the room as
        // well as the presenter, so a phone can show that others reacted too.
        io.to(room.presenters(sessionId))
          .to(room.participants(sessionId))
          .emit('reaction', { emoji: parsed.data.emoji });
      })();
    });

    /* ---------------- presenters ---------------- */

    socket.on('presenter:join', (raw, ack) => {
      void (async () => {
        try {
          const input = zPresenterJoin.parse(raw);
          const ownerId = await authenticate(socket);

          const session = await sessions.findOwnedSession(input.sessionId, ownerId);
          if (!session) {
            ack({ ok: false, code: 'session_not_found', message: 'That session was not found.' });
            return;
          }

          context.sessionId = session.id;
          context.ownerId = ownerId;

          await socket.join(room.presenters(context.sessionId));

          const count = await sessions.countParticipants(session.id);
          socket.emit('session:state', sessions.toSessionState(session, count));

          if (session.currentSlideId) {
            const results = await sessions.resultsFor(session, session.currentSlideId);
            if (results) socket.emit('results:update', results);
          }

          const entries = await sessions.leaderboardFor(session);
          if (entries.length > 0) socket.emit('leaderboard:update', { entries });

          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('presenter:goto', (raw, ack) => {
      void (async () => {
        try {
          const current = await requirePresenter(context);
          const input = zGoToSlide.parse(raw);

          if (!sessions.slideOf(current, input.slideId)) {
            ack({ ok: false, code: 'slide_not_found', message: 'That slide is not in this deck.' });
            return;
          }

          // Starts a quiz slide's countdown as the room first sees it.
          const session = await sessions.goToSlide(current, input.slideId);
          await broadcastSlide(io, session);

          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('presenter:participation', (raw, ack) => {
      void (async () => {
        try {
          const current = await requirePresenter(context);
          const session = await sessions.setParticipation(
            current,
            zSetParticipation.parse(raw).open,
          );
          await broadcastState(io, session);
          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('presenter:results-visible', (raw, ack) => {
      void (async () => {
        try {
          const current = await requirePresenter(context);
          const session = await sessions.setResultsVisible(
            current,
            zSetResultsVisible.parse(raw).visible,
          );
          await broadcastState(io, session);
          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('presenter:remove-response', (raw, ack) => {
      void (async () => {
        try {
          const session = await requirePresenter(context);
          const input = zRemoveResponse.parse(raw);

          const { slideId } = await sessions.removeResponse(
            session.id,
            session.ownerId,
            input.responseId,
          );

          const sessionId = session.id;
          io.to(room.presenters(sessionId)).emit('response:removed', {
            slideId,
            responseId: input.responseId,
          });

          const results = await sessions.resultsFor(session, slideId);
          if (results) io.to(room.presenters(sessionId)).emit('results:update', results);

          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('presenter:end', (ack) => {
      void (async () => {
        try {
          const session = await requirePresenter(context);
          const sessionId = session.id;

          await sessions.endSession(sessionId, session.ownerId);

          io.to(room.participants(sessionId))
            .to(room.presenters(sessionId))
            .emit('session:ended', { reason: 'closed_by_presenter' });

          ack({ ok: true });
        } catch (err) {
          ack(toAck(err));
        }
      })();
    });

    socket.on('disconnect', () => {
      answerLimit.forget(socket.id);
      reactionLimit.forget(socket.id);
      joinLimit.forget(socket.id);

      const { sessionId, participantId } = context;
      if (!sessionId || !participantId) return;

      // The count is of people who joined, not sockets currently open: a
      // phone that locks its screen has not left the room.
      announceCount(io, sessionId);
    });
  });

  logger.info('Realtime gateway attached');
  return io;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads the presenter's access token off the handshake.
 *
 * Presenters must prove who they are; participants must not have to. The
 * token comes through `auth` rather than a query string so it stays out of
 * server logs and proxy records.
 */
async function authenticate(socket: Sock): Promise<string> {
  const auth = socket.handshake.auth as { token?: unknown };
  const token = typeof auth.token === 'string' ? auth.token : '';

  if (!token) throw new HttpError(401, 'Please sign in.', 'no_token');

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw new HttpError(401, 'Your session expired.', 'token_expired');
  }

  const [user] = isId(claims.sub)
    ? await db
        .select({ tokenVersion: users.tokenVersion })
        .from(users)
        .where(and(eq(users.id, claims.sub), isNull(users.deletedAt)))
    : [];

  if (!user) throw new HttpError(401, 'Please sign in.', 'user_not_found');
  if (user.tokenVersion !== claims.tv) {
    throw new HttpError(401, 'Your session ended. Please sign in again.', 'token_revoked');
  }

  return claims.sub;
}

/** Reloads the session, confirming this socket is still its presenter. */
async function requirePresenter(context: SocketContext): Promise<Session> {
  if (!context.sessionId || !context.ownerId) {
    throw new HttpError(403, 'You are not presenting this session.', 'not_presenter');
  }

  const session = await sessions.findOwnedSession(context.sessionId, context.ownerId);
  if (!session) throw new HttpError(404, 'That session was not found.', 'session_not_found');

  return session;
}

async function broadcastState(io: GatewayServer, session: Session): Promise<void> {
  const sessionId = session.id;
  const count = await sessions.countParticipants(session.id);
  const state = sessions.toSessionState(session, count);

  io.to(room.presenters(sessionId)).to(room.participants(sessionId)).emit('session:state', state);
}

/**
 * Tells every phone which slide to show.
 *
 * Each participant gets their own payload because `answered` differs per
 * person — one phone should show a thank-you while another still shows the
 * question.
 */
async function broadcastSlide(io: GatewayServer, session: Session): Promise<void> {
  await broadcastState(io, session);

  const sessionId = session.id;
  const sockets = await io.in(room.participants(sessionId)).fetchSockets();

  // A socket in the participants room always has an id; any that somehow
  // does not is skipped rather than guessed at.
  const participantIds = sockets
    .map((participantSocket) => participantSocket.data.participantId)
    .filter((id): id is string => id !== undefined);

  // One pair of queries for the whole room, rather than a pair per phone.
  const slideFor = await sessions.participantSlidesFor(session, participantIds);

  for (const participantSocket of sockets) {
    const { participantId } = participantSocket.data;
    if (!participantId) continue;

    participantSocket.emit('slide:show', slideFor(participantId));
  }

  if (session.currentSlideId) {
    const results = await sessions.resultsFor(session, session.currentSlideId);
    if (results) io.to(room.presenters(sessionId)).emit('results:update', results);
  }

  // A leaderboard slide needs the standings the moment it appears, not
  // after the next answer happens to arrive.
  const slide = sessions.slideOf(session, session.currentSlideId);

  if (slide?.kind === 'leaderboard') {
    const entries = await sessions.leaderboardFor(session);
    io.to(room.presenters(sessionId)).emit('leaderboard:update', { entries });
  }
}

/**
 * Stops every broadcast still waiting on its window.
 *
 * Called before the database closes: a run that fired afterwards would
 * query a pool that is gone, and its timer would hold the process open
 * past the point where it was asked to stop.
 */
export function stopBroadcasts(): void {
  resultsBroadcast.clear();
  leaderboardBroadcast.clear();
  countBroadcast.clear();
}

export const realtimeInternals = { RateLimiter, isProduction };
