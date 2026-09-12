import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One answer, from one participant, to one slide.
 *
 * This is the highest-volume collection in the product by a wide margin, so
 * the shape is kept deliberately lean and every index earns its place.
 *
 * Two design decisions worth calling out:
 *
 *   1. `clientMsgId` makes writes idempotent. The phone generates it before
 *      sending, so a retry after a dropped connection is recognised and
 *      counted exactly once. This is what makes the offline queue safe.
 *
 *   2. Deletions are soft. When a presenter removes an inappropriate answer
 *      mid-session, the row stays with `deletedAt` set. Live aggregates skip
 *      it, but the audit trail survives — which matters if someone later
 *      asks what was said and by whom.
 */
const responseSchema = new Schema(
  {
    sessionId: { type: Types.ObjectId, ref: 'Session', required: true },
    slideId: { type: String, required: true, maxlength: 64 },
    participantId: { type: Types.ObjectId, ref: 'Participant', required: true },

    /** Denormalised from the slide so aggregation never needs the snapshot. */
    kind: { type: String, required: true, maxlength: 40 },

    /**
     * The answer itself, shaped per slide kind and validated against the Zod
     * schema from the shared registry before it ever reaches this model.
     */
    payload: { type: Schema.Types.Mixed, required: true },

    /** Client-generated id used to make retries idempotent. */
    clientMsgId: { type: String, required: true, maxlength: 64 },

    /* ---- quiz scoring (null on non-quiz slides) ---- */
    isCorrect: { type: Boolean, default: null },
    points: { type: Number, default: null },
    elapsedMs: { type: Number, default: null },

    /** Upvotes from other participants, used on open text and Q&A. */
    upvotes: { type: Number, default: 0 },

    /** Set when a presenter removes the answer, or the filter rejects it. */
    deletedAt: { type: Date, default: null },
    deletedReason: {
      type: String,
      enum: ['presenter', 'profanity', 'moderation', null],
      default: null,
    },

    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

/**
 * Idempotency guard. A retried submission carrying the same clientMsgId hits
 * this unique index and is rejected as a duplicate rather than double-counted.
 */
responseSchema.index({ sessionId: 1, clientMsgId: 1 }, { unique: true });

/**
 * The hot path: rebuilding one slide's aggregate. Partial on deletedAt so the
 * index only carries live rows, which keeps it small and fast.
 */
responseSchema.index(
  { sessionId: 1, slideId: 1, submittedAt: 1 },
  { partialFilterExpression: { deletedAt: null } },
);

/** Enforcing one-answer-per-device, and building per-person exports. */
responseSchema.index({ sessionId: 1, participantId: 1, slideId: 1 });

/** Quiz scoring sweeps and the leaderboard. */
responseSchema.index(
  { sessionId: 1, participantId: 1, points: -1 },
  { partialFilterExpression: { points: { $ne: null } } },
);

/** Retention purge job. */
responseSchema.index({ submittedAt: 1 });

export type ResponseDoc = HydratedDocument<InferSchemaType<typeof responseSchema>>;

export const Response = model('Response', responseSchema);
