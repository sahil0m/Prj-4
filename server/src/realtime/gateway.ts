import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { Types } from 'mongoose';
import { isProduction, isAllowedOrigin } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { Session, User, AudienceQuestion, Response } from '../models/index.js';
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

const answerLimit = new RateLimiter(30, 60_000);
const reactionLimit = new RateLimiter(20, 10_000);
const joinLimit = new RateLimiter(10, 60_000);

export function attachRealtime(
  httpServer: HttpServer,
): Server<ClientEvents, ServerEvents, Record<string, never>, SocketContext> {
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

          context.sessionId = session._id.toString();
          context.participantId = participant._id.toString();

          await socket.join(room.participants(context.sessionId));

          const count = await sessions.countParticipants(session._id);
          const slide = await sessions.participantSlideOf(session, participant._id);

          const result: JoinResult = {
            ok: true,
            participantId: context.participantId,
            session: sessions.toSessionState(session, count),
            slide,
            displayName: participant.displayName,
            collectNames: sessions.collectsNames(session),
            allowReactions: sessions.allowsReactions(session),
            allowQuestions: sessions.allowsQuestions(session),
          };
          ack(result);

          // Everyone watching sees the room fill up.
          io.to(room.presenters(context.sessionId))
            .to(room.participants(context.sessionId))
            .emit('participants:count', { count });
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

          const session = await Session.findById(sessionId);
          const participant = await loadParticipant(participantId);
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

          const results = await sessions.resultsFor(session, input.slideId);
          if (results) {
            io.to(room.presenters(sessionId)).emit('results:update', results);

            const settings = sessions.snapshotOf(session).settings ?? {};
            if (settings.showResultsToParticipants === true) {
              io.to(room.participants(sessionId)).emit('results:update', results);
            }
          }

          io.to(room.presenters(sessionId)).emit('response:new', {
            slideId: input.slideId,
            responseId,
            payload: input.payload,
            displayName: participant.displayName,
          });

          // Quiz slides carry a score, so the standings move on every answer.
          const slide = sessions.slideOf(session, input.slideId);

          if (slide && definitionFor(slide.kind).isQuiz) {
            const entries = await sessions.leaderboardFor(session);
            io.to(room.presenters(sessionId)).emit('leaderboard:update', { entries });

            const mine = entries.find((entry) => entry.participantId === participantId);
            const stored = await Response.findById(responseId).select('isCorrect points').lean();

            // Only to this socket: a phone that could see the whole board
            // would turn the quiz into a copying exercise.
            socket.emit('quiz:result', {
              slideId: input.slideId,
              correct: stored?.isCorrect === true,
              points: stored?.points ?? 0,
              totalScore: mine?.score ?? 0,
              rank: mine?.rank ?? null,
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

          const questionSession = await Session.findById(sessionId);
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
          const participant = await loadParticipant(participantId);

          const question = await AudienceQuestion.create({
            sessionId: new Types.ObjectId(sessionId),
            participantId: new Types.ObjectId(participantId),
            body: input.text,
            // Denormalised so the presenter's queue needs no second lookup,
            // and so it still reads correctly if the participant is removed.
            authorName: participant?.displayName ?? '',
            clientMsgId: input.clientMsgId,
          });

          ack({ ok: true });

          io.to(room.presenters(sessionId)).emit('question:new', {
            id: question._id.toString(),
            text: question.body,
            displayName: question.authorName,
            upvotes: 0,
          });
        } catch (err) {
          // A repeated clientMsgId means the phone retried; that is a success.
          if (isDuplicateKey(err)) {
            ack({ ok: true });
            return;
          }
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

          const session = await Session.findById(sessionId);
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
          const session = await Session.findById(sessionId);

          if (!session) {
            ack({ ok: false, code: 'session_not_found', message: 'That session has ended.' });
            return;
          }

          const slide = await sessions.moveParticipant(
            session,
            new Types.ObjectId(participantId),
            input.direction,
          );

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
        const reactionSession = await Session.findById(sessionId);
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

          const session = await Session.findOne({ _id: input.sessionId, ownerId });
          if (!session) {
            ack({ ok: false, code: 'session_not_found', message: 'That session was not found.' });
            return;
          }

          context.sessionId = session._id.toString();
          context.ownerId = ownerId;

          await socket.join(room.presenters(context.sessionId));

          const count = await sessions.countParticipants(session._id);
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
          const session = await requirePresenter(context);
          const input = zGoToSlide.parse(raw);

          const slide = sessions.slideOf(session, input.slideId);
          if (!slide) {
            ack({ ok: false, code: 'slide_not_found', message: 'That slide is not in this deck.' });
            return;
          }

          session.currentSlideId = input.slideId;

          // A quiz slide's clock starts when the room first sees it, so
          // everyone is scored against the same moment.
          if (Number(slide.config.countdownSeconds ?? 0) > 0) {
            session.countdownStartedAt = new Date();
            session.countdownSlideId = input.slideId;
          } else {
            session.countdownStartedAt = null;
            session.countdownSlideId = null;
          }

          await session.save();
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
          const session = await requirePresenter(context);
          session.participationOpen = zSetParticipation.parse(raw).open;
          await session.save();
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
          const session = await requirePresenter(context);
          session.resultsVisible = zSetResultsVisible.parse(raw).visible;
          await session.save();
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
            session._id.toString(),
            objectIdToString(session.ownerId),
            input.responseId,
          );

          const sessionId = session._id.toString();
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
          const sessionId = session._id.toString();

          await sessions.endSession(sessionId, objectIdToString(session.ownerId));

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
      void (async () => {
        try {
          const count = await sessions.countParticipants(new Types.ObjectId(sessionId));
          io.to(room.presenters(sessionId)).emit('participants:count', { count });
        } catch {
          // A disconnect during shutdown is not worth logging.
        }
      })();
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

  const user = await User.findOne({ _id: claims.sub, deletedAt: null })
    .select('tokenVersion')
    .lean();

  if (!user) throw new HttpError(401, 'Please sign in.', 'user_not_found');
  if (user.tokenVersion !== claims.tv) {
    throw new HttpError(401, 'Your session ended. Please sign in again.', 'token_revoked');
  }

  return claims.sub;
}

/** Reloads the session, confirming this socket is still its presenter. */
async function requirePresenter(context: SocketContext) {
  if (!context.sessionId || !context.ownerId) {
    throw new HttpError(403, 'You are not presenting this session.', 'not_presenter');
  }

  const session = await Session.findOne({ _id: context.sessionId, ownerId: context.ownerId });
  if (!session) throw new HttpError(404, 'That session was not found.', 'session_not_found');

  return session;
}

async function loadParticipant(participantId: string) {
  const { Participant } = await import('../models/index.js');
  return Participant.findById(participantId);
}

async function broadcastState(
  io: Server<ClientEvents, ServerEvents, Record<string, never>, SocketContext>,
  session: Awaited<ReturnType<typeof requirePresenter>>,
): Promise<void> {
  const sessionId = session._id.toString();
  const count = await sessions.countParticipants(session._id);
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
async function broadcastSlide(
  io: Server<ClientEvents, ServerEvents, Record<string, never>, SocketContext>,
  session: Awaited<ReturnType<typeof requirePresenter>>,
): Promise<void> {
  await broadcastState(io, session);

  const sessionId = session._id.toString();
  const sockets = await io.in(room.participants(sessionId)).fetchSockets();

  for (const participantSocket of sockets) {
    const { participantId } = participantSocket.data;
    // A socket in the participants room always has an id; skip rather than
    // guess if one somehow does not.
    if (!participantId) continue;

    const slide = await sessions.participantSlideOf(session, new Types.ObjectId(participantId));
    participantSocket.emit('slide:show', slide);
  }

  if (session.currentSlideId) {
    const results = await sessions.resultsFor(session, session.currentSlideId);
    if (results) io.to(room.presenters(sessionId)).emit('results:update', results);
  }

  // A leaderboard slide needs the standings the moment it appears, not
  // after the next answer happens to arrive.
  const slide = sessions.slideOf(session, session.currentSlideId ?? null);

  if (slide?.kind === 'leaderboard') {
    const entries = await sessions.leaderboardFor(session);
    io.to(room.presenters(sessionId)).emit('leaderboard:update', { entries });
  }
}

/**
 * Mongoose types a populated-or-not ref as a union, so `.toString()` on it is
 * flagged as a possible Object stringification. It is always an ObjectId here
 * because these documents are never populated.
 */
function objectIdToString(value: unknown): string {
  return (value as Types.ObjectId).toString();
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export const realtimeInternals = { RateLimiter, isProduction };
