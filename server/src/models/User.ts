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

    /**
     * Argon2id hash. Never selected by default, so it cannot leak by
     * accident. Null for accounts created purely through a social login —
     * those users have no password to hash.
     */
    passwordHash: {
      type: String,
      default: null,
      select: false,
    },

    /**
     * Mirrors "passwordHash is set". It exists because passwordHash is
     * select:false, so any query that does not explicitly ask for the hash
     * reads it as absent — and a serialiser deriving the flag from the hash
     * would then report "no password" for an account that has one. This
     * field is always selected, and the pre-save hook below keeps it true to
     * the hash, so callers never have to know how the document was loaded.
     */
    hasPassword: {
      type: Boolean,
      default: false,
    },

    /**
     * Linked social accounts. Storing the provider's stable subject id
     * rather than the email, because a user can change their email at the
     * provider and we must still recognise them.
     */
    identities: {
      type: [
        new Schema(
          {
            provider: { type: String, required: true, enum: ['google'] },
            subject: { type: String, required: true, maxlength: 128 },
            email: { type: String, default: '', maxlength: 320 },
            linkedAt: { type: Date, default: Date.now },
          },
          { _id: false },
        ),
      ],
      default: [],
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

    /**
     * Access level.
     *
     * Deliberately a small enum rather than a permission set: this system
     * has exactly two kinds of person, and a flexible permission model
     * nobody needs is a source of bugs rather than of flexibility.
     */
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
      index: true,
    },

    /**
     * Set when an admin disables the account.
     *
     * Suspension bumps tokenVersion, so it takes effect on the next request
     * rather than whenever the current access token happens to expire.
     */
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: '', maxlength: 300 },

    /** Rolling count, used to keep one user from exhausting the free tier. */
    aiRequestsToday: { type: Number, default: 0 },
    aiRequestsResetAt: { type: Date, default: null },

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
// Finding the account behind a social login.
userSchema.index({ 'identities.provider': 1, 'identities.subject': 1 });

/**
 * An account must have at least one way in. Without this guard a bug could
 * leave someone with no password and no linked identity, locked out of their
 * own data with no recovery path.
 *
 * The guard only runs on creation, and on saves where passwordHash was
 * actually loaded. `passwordHash` is select:false, so an ordinary
 * findOne().save() round trip has no idea whether a password exists — and
 * treating "not loaded" as "not set" would reject every normal update.
 */
/**
 * Derives hasPassword from the hash. Only runs when the hash was actually
 * loaded: on a save from a query that omitted it, the stored flag is already
 * correct and must be left alone rather than cleared to false.
 */
userSchema.pre('save', function (next) {
  if (this.isNew || this.get('passwordHash') !== undefined) {
    this.hasPassword = typeof this.passwordHash === 'string' && this.passwordHash.length > 0;
  }
  next();
});

userSchema.pre('validate', function (next) {
  const hashWasLoaded = this.isNew || this.get('passwordHash') !== undefined;
  if (!hashWasLoaded) {
    next();
    return;
  }

  const hasPassword = typeof this.passwordHash === 'string' && this.passwordHash.length > 0;
  const hasIdentity = this.identities.length > 0;

  if (!hasPassword && !hasIdentity) {
    next(new Error('An account needs either a password or a linked social login.'));
    return;
  }
  next();
});

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const User = model('User', userSchema);
