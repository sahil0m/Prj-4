import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A person with an account. Participants in a session are NOT users —
 * they are anonymous by default and live in the Participant model.
 */
const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 320,
    },

    /** Argon2id hash. Never selected by default, so it cannot leak by accident. */
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    name: { type: String, required: true, trim: true, maxlength: 100 },

    avatarUrl: { type: String, default: '', maxlength: 2000 },

    /** BCP-47 tag, used to pick the interface language. */
    locale: { type: String, default: 'en', maxlength: 16 },

    emailVerifiedAt: { type: Date, default: null },

    /**
     * Bumped whenever the user changes their password or logs out everywhere.
     * Tokens issued before this value are rejected, which is how "log out of
     * all devices" works without keeping a session table.
     */
    tokenVersion: { type: Number, default: 0 },

    lastSeenAt: { type: Date, default: null },

    /** Soft delete. Set on account deletion; a job purges the row later. */
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Fast lookup on login, skipping deleted accounts.
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ deletedAt: 1 });

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const User = model('User', userSchema);
