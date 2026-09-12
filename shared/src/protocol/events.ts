import { z } from 'zod';
import type { SlideKind } from '../slides/kinds.js';

/**
 * The realtime contract.
 *
 * Both the presenter app and the phone app compile against these types, and
 * the server validates every inbound payload against these schemas. An event
 * name or shape can therefore only change in one place, and a mismatch is a
 * compile error rather than a silent no-op in a live room.
 */

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

/**
 * Socket.IO rooms per session. Presenters and participants are separated so
 * that presenter-only information — the full response list, participant
 * names, control state — is never broadcast to phones.
 */
export const room = {
  presenters: (sessionId: string): string => `s:${sessionId}:presenters`,
  participants: (sessionId: string): string => `s:${sessionId}:participants`,
};

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

export const zJoinCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'A join code is six digits.');

/** A device's self-generated id. Opaque; never derived from anything personal. */
export const zDeviceToken = z.string().min(16).max(64);

export const zClientMsgId = z.string().min(8).max(64);

/* ------------------------------------------------------------------ */
/* Participant -> server                                               */
/* ------------------------------------------------------------------ */

export const zParticipantJoin = z.object({
  joinCode: zJoinCode,
  deviceToken: zDeviceToken,
  displayName: z.string().trim().max(60).optional(),
  locale: z.string().max(16).optional(),
});

export const zSubmitAnswer = z.object({
  slideId: z.string().max(64),
  /** Validated against the slide kind's answer schema once the kind is known. */
  payload: z.unknown(),
  /** Generated before sending, so a retry is counted once. */
  clientMsgId: zClientMsgId,
});

export const zUpvote = z.object({
  responseId: z.string().max(64),
  /** False retracts a previous upvote. */
  up: z.boolean().default(true),
});

export const zAskQuestion = z.object({
  text: z.string().trim().min(1).max(500),
  clientMsgId: zClientMsgId,
});

export const zReaction = z.object({
  emoji: z.enum(['clap', 'heart', 'laugh', 'wow', 'thumbsUp']),
});

/* ------------------------------------------------------------------ */
/* Presenter -> server                                                 */
/* ------------------------------------------------------------------ */

export const zPresenterJoin = z.object({ sessionId: z.string().max(64) });

export const zGoToSlide = z.object({ slideId: z.string().max(64) });

export const zSetParticipation = z.object({ open: z.boolean() });

export const zSetResultsVisible = z.object({ visible: z.boolean() });

export const zRemoveResponse = z.object({ responseId: z.string().max(64) });

/* ------------------------------------------------------------------ */
/* Server -> everyone                                                  */
/* ------------------------------------------------------------------ */

export interface SessionState {
  sessionId: string;
  state: 'scheduled' | 'live' | 'paused' | 'closed';
  currentSlideId: string | null;
  participationOpen: boolean;
  resultsVisible: boolean;
  participantCount: number;
  /** Set while a quiz countdown runs, so late joiners see the right clock. */
  countdownEndsAt: string | null;
}

/** The slide as a phone needs to render its input. */
export interface ParticipantSlide {
  id: string;
  kind: SlideKind;
  config: Record<string, unknown>;
  /** Answers this device has already submitted for this slide. */
  answered: boolean;
}

/** One slide's tallied results. Shape depends on the kind. */
export interface SlideResults {
  slideId: string;
  kind: SlideKind;
  /** Total non-deleted responses. */
  count: number;
  /** Tally shaped per kind; see results.ts for the per-kind shapes. */
  data: unknown;
}

/* ------------------------------------------------------------------ */
/* Event maps                                                          */
/* ------------------------------------------------------------------ */

/** Everything the server can send. */
export interface ServerEvents {
  'session:state': (state: SessionState) => void;
  'session:ended': (payload: { reason: 'closed_by_presenter' }) => void;

  /** The slide a phone should now show. */
  'slide:show': (slide: ParticipantSlide | null) => void;

  /** Live tally, sent to presenters continuously and to phones on request. */
  'results:update': (results: SlideResults) => void;

  /** A single new answer, for presenters that render arrivals individually. */
  'response:new': (payload: {
    slideId: string;
    responseId: string;
    payload: unknown;
    displayName: string;
  }) => void;

  'response:removed': (payload: { slideId: string; responseId: string }) => void;

  'participants:count': (payload: { count: number }) => void;

  reaction: (payload: { emoji: string }) => void;

  'question:new': (payload: {
    id: string;
    text: string;
    displayName: string;
    upvotes: number;
  }) => void;

  /** Sent instead of throwing, so a phone can show a readable message. */
  error: (payload: { code: string; message: string }) => void;
}

/** Everything a client can send. The ack callback reports success per call. */
export interface ClientEvents {
  'participant:join': (
    payload: z.input<typeof zParticipantJoin>,
    ack: (result: JoinResult) => void,
  ) => void;

  'participant:answer': (
    payload: z.input<typeof zSubmitAnswer>,
    ack: (result: AckResult) => void,
  ) => void;

  'participant:upvote': (payload: z.input<typeof zUpvote>, ack: (r: AckResult) => void) => void;
  'participant:question': (
    payload: z.input<typeof zAskQuestion>,
    ack: (r: AckResult) => void,
  ) => void;
  'participant:reaction': (payload: z.input<typeof zReaction>) => void;

  'presenter:join': (payload: z.input<typeof zPresenterJoin>, ack: (r: AckResult) => void) => void;
  'presenter:goto': (payload: z.input<typeof zGoToSlide>, ack: (r: AckResult) => void) => void;
  'presenter:participation': (
    payload: z.input<typeof zSetParticipation>,
    ack: (r: AckResult) => void,
  ) => void;
  'presenter:results-visible': (
    payload: z.input<typeof zSetResultsVisible>,
    ack: (r: AckResult) => void,
  ) => void;
  'presenter:remove-response': (
    payload: z.input<typeof zRemoveResponse>,
    ack: (r: AckResult) => void,
  ) => void;
  'presenter:end': (ack: (r: AckResult) => void) => void;
}

export type AckResult = { ok: true } | { ok: false; code: string; message: string };

export type JoinResult =
  | {
      ok: true;
      participantId: string;
      session: SessionState;
      slide: ParticipantSlide | null;
      /** Echoed back so a phone that was given a name keeps showing it. */
      displayName: string;
      collectNames: boolean;
    }
  | { ok: false; code: string; message: string };
