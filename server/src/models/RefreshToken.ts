import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One issued refresh token.
 *
 * Rows are kept after being used rather than deleted, because a used token
 * being presented again is precisely the signal we need to detect theft.
 * A TTL index clears them once they can no longer tell us anything.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },

    /** SHA-256 of the token. The plain value exists only in the user's cookie. */
    tokenHash: { type: String, required: true, maxlength: 128 },

    /**
     * Every token descended from a single login shares a family id. When
     * reuse is detected we revoke the whole family, because we cannot tell
     * the legitimate holder from the attacker.
     */
    family: { type: String, required: true, index: true, maxlength: 64 },

    /** Set when this token is exchanged. A second use is the theft signal. */
    usedAt: { type: Date, default: null },

    /** Set when revoked, with the reason, for the security audit trail. */
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ['rotated', 'logout', 'logout_all', 'reuse_detected', 'password_changed', null],
      default: null,
    },

    expiresAt: { type: Date, required: true },

    /**
     * Coarse device hints, shown on the "your sessions" screen so a user can
     * recognise and revoke a device. Deliberately coarse: enough to say
     * "Chrome on Windows", not enough to fingerprint.
     */
    userAgent: { type: String, default: '', maxlength: 300 },
    ipHash: { type: String, default: '', maxlength: 64 },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

/** Lookup on refresh. */
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
/** Revoking a whole family at once. */
refreshTokenSchema.index({ family: 1, revokedAt: 1 });
/** Listing a user's active sessions. */
refreshTokenSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });
/** Mongo removes expired rows automatically. */
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = HydratedDocument<InferSchemaType<typeof refreshTokenSchema>>;

export const RefreshToken = model('RefreshToken', refreshTokenSchema);
