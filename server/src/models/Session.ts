import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One live run of a deck.
 *
 * The critical field is `deckSnapshot`: a frozen copy of the deck taken the
 * moment the session starts. Editing the deck afterwards must never change
 * what a past session's results mean.
 *
 * Two ways in, deliberately separate:
 *   joinCode - short, typed or read aloud, recyclable after the session ends
 *   joinSlug - permanent, safe to print on a poster or put in an invitation
 */
const sessionSchema = new Schema(
  {
    deckId: { type: Types.ObjectId, ref: 'Deck', required: true, index: true },
    ownerId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Types.ObjectId, ref: 'Organization', default: null },

    title: { type: String, required: true, maxlength: 200 },

    /** 6 digits. Unique only among live sessions — see the partial index below. */
    joinCode: { type: String, required: true, maxlength: 12 },

    /** Permanent, never reissued. */
    joinSlug: { type: String, required: true, maxlength: 32 },

    state: {
      type: String,
      enum: ['scheduled', 'live', 'paused', 'closed'],
      default: 'live',
      index: true,
    },

    mode: {
      type: String,
      enum: ['presenter_paced', 'audience_paced'],
      required: true,
    },

    /** Frozen copy of the deck as it was when the session started. */
    deckSnapshot: { type: Schema.Types.Mixed, required: true },

    /** Slide id from the snapshot. Null before the presenter advances. */
    currentSlideId: { type: String, default: null, maxlength: 64 },

    /** Master switch; individual slides can also be closed. */
    participationOpen: { type: Boolean, default: true },

    /** Presenter has revealed the current slide's results. */
    resultsVisible: { type: Boolean, default: true },

    /** Set when a quiz countdown starts, so scoring can measure elapsed time. */
    countdownStartedAt: { type: Date, default: null },
    countdownSlideId: { type: String, default: null, maxlength: 64 },

    stats: {
      participantCount: { type: Number, default: 0 },
      responseCount: { type: Number, default: 0 },
      peakConcurrent: { type: Number, default: 0 },
    },

    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },

    /** Raw responses are purged after this date; aggregates are kept. */
    retentionUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * A join code only needs to be unique among sessions that are currently
 * joinable. Once a session closes, its code is free to be reused, which
 * keeps six digits comfortably sufficient.
 */
sessionSchema.index(
  { joinCode: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ['scheduled', 'live', 'paused'] } },
  },
);

sessionSchema.index({ joinSlug: 1 }, { unique: true });
// Session history for a deck, newest first.
sessionSchema.index({ deckId: 1, startedAt: -1 });
// Dashboard: a user's recent sessions.
sessionSchema.index({ ownerId: 1, startedAt: -1 });

export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;

export const Session = model('Session', sessionSchema);
