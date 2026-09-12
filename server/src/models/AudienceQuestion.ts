import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * A question sent by the audience during a session.
 *
 * Unlike a Response, this is not attached to one slide — people can ask at
 * any point, and the presenter surfaces the queue when they choose.
 */
const audienceQuestionSchema = new Schema(
  {
    sessionId: { type: Types.ObjectId, ref: 'Session', required: true, index: true },
    participantId: { type: Types.ObjectId, ref: 'Participant', required: true },

    body: { type: String, required: true, trim: true, maxlength: 500 },

    /** Shown next to the question when the session collects names. */
    authorName: { type: String, default: '', maxlength: 60 },

    upvotes: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'answered'],
      default: 'approved',
      index: true,
    },

    /** Presenter pinned this question to the big screen. */
    pinnedAt: { type: Date, default: null },

    clientMsgId: { type: String, required: true, maxlength: 64 },

    createdAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
  },
  { timestamps: false },
);

/** Idempotent submission, same reasoning as Response. */
audienceQuestionSchema.index({ sessionId: 1, clientMsgId: 1 }, { unique: true });
/** The moderation queue, and the "most voted" ordering. */
audienceQuestionSchema.index({ sessionId: 1, status: 1, upvotes: -1, createdAt: -1 });

export type AudienceQuestionDoc = HydratedDocument<
  InferSchemaType<typeof audienceQuestionSchema>
>;

export const AudienceQuestion = model('AudienceQuestion', audienceQuestionSchema);
