import { sql } from 'drizzle-orm';
import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
  customType,
} from 'drizzle-orm/pg-core';

/**
 * The database, as tables.
 *
 * Moved from MongoDB. Three decisions shape everything below:
 *
 *   1. Ids stay 24-character hex strings. Every existing row keeps the id it
 *      had in MongoDB, so deck and session URLs, the `sub` inside a signed
 *      access token, and the refresh tokens in people's cookies all remain
 *      valid across the move. Nobody is logged out and no bookmark breaks.
 *      New ids keep the same shape and the same time ordering, which the
 *      admin list's keyset pagination depends on.
 *
 *   2. What was a nested document becomes a table only where it is queried
 *      on its own. A user's linked Google accounts are looked up by provider
 *      and subject, so they get a table with a real uniqueness guarantee.
 *      A deck's slides are only ever read and written whole, as is a
 *      session's frozen snapshot, so they stay JSONB -- splitting them into
 *      rows would turn one read into a join for no query that needs it.
 *
 *   3. Rules the old models enforced in application code become database
 *      constraints where Postgres can express them: foreign keys, CHECKs on
 *      every enum, and a generated column for `has_password` so that flag
 *      can no longer drift from the hash it describes.
 */

const id = (name = 'id') => varchar(name, { length: 24 });

/** Raw bytes, for the images held in the database. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
/** Set on insert, and refreshed by every update made through Drizzle. */
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** A nullable instant. */
const at = (name: string) => timestamp(name, { withTimezone: true });

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  'users',
  {
    id: id().primaryKey(),

    /** Stored lowercased; the service normalises before every write and lookup. */
    email: varchar('email', { length: 320 }).notNull(),

    /** Argon2id. Null for an account that only ever signed in with Google. */
    passwordHash: text('password_hash'),

    /**
     * Derived by Postgres, never written.
     *
     * In MongoDB this was a separate field kept in step by a save hook,
     * because the hash was excluded from queries by default and a missing
     * hash read the same as no password. That hook was a bug that had
     * already happened once. A generated column cannot disagree with the
     * value it is computed from.
     */
    hasPassword: boolean('has_password')
      .notNull()
      .generatedAlwaysAs(sql`password_hash IS NOT NULL`),

    name: varchar('name', { length: 100 }).notNull(),
    avatarUrl: varchar('avatar_url', { length: 2000 }).notNull().default(''),
    locale: varchar('locale', { length: 16 }).notNull().default('en'),
    emailVerifiedAt: at('email_verified_at'),

    /** Bumped to invalidate every outstanding access token at once. */
    tokenVersion: integer('token_version').notNull().default(0),

    role: varchar('role', { length: 16 }).$type<'user' | 'admin'>().notNull().default('user'),

    suspendedAt: at('suspended_at'),
    suspendedReason: varchar('suspended_reason', { length: 300 }).notNull().default(''),

    aiRequestsToday: integer('ai_requests_today').notNull().default(0),
    aiRequestsResetAt: at('ai_requests_reset_at'),

    lastSeenAt: at('last_seen_at'),
    deletedAt: at('deleted_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    index('users_role_idx').on(t.role),
    index('users_deleted_at_idx').on(t.deletedAt),
    check('users_role_check', sql`${t.role} IN ('user', 'admin')`),
    // The service lowercases on the way in; this makes sure nothing else can
    // write a mixed-case address that would then never match a login.
    check('users_email_lowercase_check', sql`${t.email} = lower(${t.email})`),
  ],
);

/**
 * Linked sign-in providers.
 *
 * A table rather than an array on the user because it is searched on its
 * own: signing in with Google means finding the account that owns this
 * Google subject. The primary key makes "one Google account, one Pulse
 * account" a guarantee rather than a hope -- MongoDB's index here was not
 * unique, so two accounts could in principle have claimed the same identity.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    provider: varchar('provider', { length: 32 }).$type<'google'>().notNull(),
    subject: varchar('subject', { length: 128 }).notNull(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull().default(''),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_identities_pkey', columns: [t.provider, t.subject] }),
    index('user_identities_user_id_idx').on(t.userId),
    check('user_identities_provider_check', sql`${t.provider} IN ('google')`),
  ],
);

/* ------------------------------------------------------------------ */
/* Refresh tokens                                                      */
/* ------------------------------------------------------------------ */

export const REVOKE_REASONS = [
  'rotated',
  'logout',
  'logout_all',
  'reuse_detected',
  'password_changed',
] as const;

export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** SHA-256 of the token; the plain value only ever exists in the cookie. */
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),

    /** Shared by every token descended from one sign-in, for reuse detection. */
    family: varchar('family', { length: 64 }).notNull(),

    usedAt: at('used_at'),
    revokedAt: at('revoked_at'),
    revokedReason: varchar('revoked_reason', { length: 32 }).$type<RevokeReason>(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    userAgent: varchar('user_agent', { length: 300 }).notNull().default(''),
    ipHash: varchar('ip_hash', { length: 64 }).notNull().default(''),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_key').on(t.tokenHash),
    index('refresh_tokens_family_idx').on(t.family, t.revokedAt),
    index('refresh_tokens_user_idx').on(t.userId, t.revokedAt, t.expiresAt.desc()),
    // MongoDB deleted expired rows with a TTL index; Postgres has no such
    // thing, so the cleanup job does it, and this keeps that sweep cheap.
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
    check(
      'refresh_tokens_revoked_reason_check',
      sql`${t.revokedReason} IS NULL OR ${t.revokedReason} IN ('rotated', 'logout', 'logout_all', 'reuse_detected', 'password_changed')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* Decks                                                               */
/* ------------------------------------------------------------------ */

/** One slide inside a deck's JSONB array. */
export interface StoredSlide {
  id: string;
  kind: string;
  /** Fractional, so one slide can move without renumbering the rest. */
  position: number;
  config: Record<string, unknown>;
}

export interface DeckTheme {
  preset: string;
  accent: string;
  background: string;
  fontFamily: string;
  logoUrl: string;
  mode: 'dark' | 'light';
}

export interface DeckSettings {
  mode: 'presenter_paced' | 'audience_paced';
  collectNames: boolean;
  showResultsToParticipants: boolean;
  profanityFilter: boolean;
  reactions: boolean;
  chat: boolean;
  oneAnswerPerDevice: boolean;
}

export const DEFAULT_THEME: DeckTheme = {
  preset: 'midnight',
  accent: '#6366f1',
  background: '',
  fontFamily: '',
  logoUrl: '',
  mode: 'dark',
};

export const DEFAULT_SETTINGS: DeckSettings = {
  mode: 'presenter_paced',
  collectNames: false,
  showResultsToParticipants: false,
  profanityFilter: true,
  reactions: true,
  chat: false,
  oneAnswerPerDevice: true,
};

export const decks = pgTable(
  'decks',
  {
    id: id().primaryKey(),
    ownerId: id('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: 200 }).notNull().default('Untitled'),
    description: varchar('description', { length: 1000 }).notNull().default(''),

    /**
     * The slides, whole.
     *
     * A deck is always read and written as a unit, so a join here would be a
     * cost with no query to justify it. Each config is validated against its
     * kind's Zod schema before it is stored.
     */
    slides: jsonb('slides').$type<StoredSlide[]>().notNull().default([]),
    theme: jsonb('theme').$type<DeckTheme>().notNull().default(DEFAULT_THEME),
    settings: jsonb('settings').$type<DeckSettings>().notNull().default(DEFAULT_SETTINGS),

    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    /** Bumped on every save. */
    revision: integer('revision').notNull().default(1),

    archivedAt: at('archived_at'),
    /** Soft delete; the cleanup job purges the row 30 days later. */
    deletedAt: at('deleted_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('decks_owner_listing_idx').on(t.ownerId, t.deletedAt, t.updatedAt.desc()),
    index('decks_deleted_at_idx').on(t.deletedAt),
    check('decks_slides_is_array_check', sql`jsonb_typeof(${t.slides}) = 'array'`),
  ],
);

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/**
 * An image someone uploaded, held in the database.
 *
 * Kept here rather than on disk so there is one thing to back up and
 * nothing to lose when the server moves. Every upload is resized and
 * re-encoded before it arrives, so these are tens of kilobytes rather
 * than the several megabytes a phone camera produces.
 *
 * Served from /api/images/<id> without authentication: the audience has
 * no account, and an image on a slide is shown to the whole room anyway.
 * The id is random, so one cannot be found by guessing.
 */
export const images = pgTable(
  'images',
  {
    id: id().primaryKey(),

    /** Who uploaded it, so their images go when their account does. */
    ownerId: id('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    mime: varchar('mime', { length: 60 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    data: bytea('data').notNull(),

    /**
     * A small copy, for where the image is shown small.
     *
     * A choice option is fifty-odd pixels on a phone, and four of them at
     * full size is megabytes to render thumbnails. Stored once at upload
     * rather than resized on every request.
     */
    thumb: bytea('thumb').notNull(),
    thumbBytes: integer('thumb_bytes').notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    index('images_owner_idx').on(t.ownerId, t.createdAt.desc()),
    // The cleanup job sweeps uploads nothing ever referenced.
    index('images_created_at_idx').on(t.createdAt),
    check('images_mime_check', sql`${t.mime} IN ('image/webp', 'image/png', 'image/jpeg')`),
  ],
);

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export const SESSION_STATES = ['scheduled', 'live', 'paused', 'closed'] as const;
export type SessionStateName = (typeof SESSION_STATES)[number];

export type SessionMode = 'presenter_paced' | 'audience_paced';

/** The deck, frozen at the moment the session started. */
export interface DeckSnapshot {
  title: string;
  slides: StoredSlide[];
  theme?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export const sessions = pgTable(
  'sessions',
  {
    id: id().primaryKey(),

    /**
     * Nullable, and cleared rather than cascaded when the deck goes.
     *
     * A deleted deck is purged after 30 days, but the record of having
     * presented it is not the deck's to take with it -- a teacher's results
     * from last term must survive tidying up their deck list.
     */
    deckId: id('deck_id').references(() => decks.id, { onDelete: 'set null' }),

    ownerId: id('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: varchar('title', { length: 200 }).notNull(),
    joinCode: varchar('join_code', { length: 12 }).notNull(),
    joinSlug: varchar('join_slug', { length: 32 }).notNull(),

    state: varchar('state', { length: 16 }).$type<SessionStateName>().notNull().default('live'),
    mode: varchar('mode', { length: 24 }).$type<SessionMode>().notNull(),

    deckSnapshot: jsonb('deck_snapshot').$type<DeckSnapshot>().notNull(),

    currentSlideId: varchar('current_slide_id', { length: 64 }),
    participationOpen: boolean('participation_open').notNull().default(true),
    resultsVisible: boolean('results_visible').notNull().default(true),

    countdownStartedAt: at('countdown_started_at'),
    countdownSlideId: varchar('countdown_slide_id', { length: 64 }),

    participantCount: integer('participant_count').notNull().default(0),
    responseCount: integer('response_count').notNull().default(0),
    peakConcurrent: integer('peak_concurrent').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: at('ended_at'),
    retentionUntil: at('retention_until'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /*
     * A join code is unique only among sessions someone could still join.
     * Once a session closes its code is free again, which is what keeps six
     * digits enough however many sessions have ever run.
     */
    uniqueIndex('sessions_live_join_code_key')
      .on(t.joinCode)
      .where(sql`${t.state} IN ('scheduled', 'live', 'paused')`),
    uniqueIndex('sessions_join_slug_key').on(t.joinSlug),
    index('sessions_deck_idx').on(t.deckId, t.startedAt.desc()),
    index('sessions_owner_idx').on(t.ownerId, t.startedAt.desc()),
    index('sessions_state_idx').on(t.state),
    check('sessions_state_check', sql`${t.state} IN ('scheduled', 'live', 'paused', 'closed')`),
    check('sessions_mode_check', sql`${t.mode} IN ('presenter_paced', 'audience_paced')`),
  ],
);

/* ------------------------------------------------------------------ */
/* Participants                                                        */
/* ------------------------------------------------------------------ */

export const participants = pgTable(
  'participants',
  {
    id: id().primaryKey(),
    sessionId: id('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    /** Generated by the phone; lets a refresh rejoin as the same person. */
    deviceToken: varchar('device_token', { length: 64 }).notNull(),

    displayName: varchar('display_name', { length: 60 }).notNull().default(''),
    userId: id('user_id').references(() => users.id, { onDelete: 'set null' }),
    locale: varchar('locale', { length: 16 }).notNull().default('en'),

    /** Running quiz total. */
    score: doublePrecision('score').notNull().default(0),

    /** Where this person has reached in an audience-paced session. */
    currentSlideId: varchar('current_slide_id', { length: 64 }),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    blockedAt: at('blocked_at'),
  },
  (t) => [
    uniqueIndex('participants_session_device_key').on(t.sessionId, t.deviceToken),
    index('participants_leaderboard_idx').on(t.sessionId, t.score.desc()),
  ],
);

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export const DELETE_REASONS = ['presenter', 'profanity', 'moderation'] as const;
export type DeleteReason = (typeof DELETE_REASONS)[number];

export const responses = pgTable(
  'responses',
  {
    id: id().primaryKey(),
    sessionId: id('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    slideId: varchar('slide_id', { length: 64 }).notNull(),
    participantId: id('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),

    /** Denormalised from the slide so aggregation never needs the snapshot. */
    kind: varchar('kind', { length: 40 }).notNull(),

    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    /** Generated by the phone before sending; makes a retry count once. */
    clientMsgId: varchar('client_msg_id', { length: 64 }).notNull(),

    isCorrect: boolean('is_correct'),
    points: doublePrecision('points'),
    elapsedMs: doublePrecision('elapsed_ms'),

    upvotes: integer('upvotes').notNull().default(0),

    deletedAt: at('deleted_at'),
    deletedReason: varchar('deleted_reason', { length: 16 }).$type<DeleteReason>(),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The idempotency guarantee behind the phone's offline queue. */
    uniqueIndex('responses_session_client_msg_key').on(t.sessionId, t.clientMsgId),

    /** The hot path: one slide's live answers. Partial, so it only holds live rows. */
    index('responses_slide_live_idx')
      .on(t.sessionId, t.slideId, t.submittedAt)
      .where(sql`${t.deletedAt} IS NULL`),

    /** One answer per device, and per-person exports. */
    index('responses_participant_idx').on(t.sessionId, t.participantId, t.slideId),

    /** The leaderboard only reads scored rows. */
    index('responses_scored_idx')
      .on(t.sessionId, t.participantId)
      .where(sql`${t.points} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    index('responses_submitted_at_idx').on(t.submittedAt),

    check(
      'responses_deleted_reason_check',
      sql`${t.deletedReason} IS NULL OR ${t.deletedReason} IN ('presenter', 'profanity', 'moderation')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* Audience questions                                                  */
/* ------------------------------------------------------------------ */

export const QUESTION_STATUSES = ['pending', 'approved', 'rejected', 'answered'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const audienceQuestions = pgTable(
  'audience_questions',
  {
    id: id().primaryKey(),
    sessionId: id('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    participantId: id('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),

    body: varchar('body', { length: 500 }).notNull(),
    /** Copied at the time of asking, so it still reads right if the person is removed. */
    authorName: varchar('author_name', { length: 60 }).notNull().default(''),

    upvotes: integer('upvotes').notNull().default(0),
    status: varchar('status', { length: 16 }).$type<QuestionStatus>().notNull().default('approved'),
    pinnedAt: at('pinned_at'),

    clientMsgId: varchar('client_msg_id', { length: 64 }).notNull(),

    createdAt: createdAt(),
    answeredAt: at('answered_at'),
  },
  (t) => [
    uniqueIndex('audience_questions_session_client_msg_key').on(t.sessionId, t.clientMsgId),
    index('audience_questions_queue_idx').on(
      t.sessionId,
      t.status,
      t.upvotes.desc(),
      t.createdAt.desc(),
    ),
    check(
      'audience_questions_status_check',
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'answered')`,
    ),
  ],
);

/* ------------------------------------------------------------------ */
/* Row types                                                           */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type Deck = typeof decks.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Participant = typeof participants.$inferSelect;
export type Response = typeof responses.$inferSelect;
export type AudienceQuestion = typeof audienceQuestions.$inferSelect;
export type Image = typeof images.$inferSelect;
