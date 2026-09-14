/**
 * Copies everything out of MongoDB into PostgreSQL.
 *
 *   npm run db:import-mongo -w server -- --dry-run     rehearse; writes nothing
 *   npm run db:import-mongo -w server                  copy for real
 *   npm run db:import-mongo -w server -- --replace     copy over existing Postgres data
 *
 * Built to be trusted rather than hoped about:
 *
 *   - MongoDB is only ever read. Nothing there is changed or deleted, so the
 *     old database stays a complete fallback until you choose to retire it.
 *
 *   - The whole copy is one transaction. Either every row arrives and passes
 *     verification, or nothing is written at all. There is no half-migrated
 *     state to recover from.
 *
 *   - Success is not "the inserts did not throw". After copying, every row is
 *     read back out of Postgres and compared field by field with the document
 *     it came from. A single difference rolls everything back and prints what
 *     differed.
 *
 *   - Ids are kept. Links, signed access tokens and the refresh tokens in
 *     people's browsers all refer to MongoDB ids, and all keep working.
 *
 *   - It refuses to write into a database that already holds Pulse data
 *     unless told to with --replace, so running it twice cannot duplicate or
 *     silently overwrite anything.
 */
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { asc, count, getTableColumns, sql } from 'drizzle-orm';
import { connectDb, disconnectDb, db, type Transaction } from '../lib/db.js';
import {
  users,
  userIdentities,
  refreshTokens,
  decks,
  sessions,
  participants,
  responses,
  audienceQuestions,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  type DeckSettings,
  type DeckTheme,
  type StoredSlide,
} from '../db/schema.js';

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const REPLACE = args.has('--replace');

const say = (line = '') => process.stdout.write(`${line}\n`);

/** Thrown to roll back a dry run once it has proved everything would work. */
class DryRunComplete extends Error {}

/* ------------------------------------------------------------------ */
/* Converting BSON values                                              */
/* ------------------------------------------------------------------ */

const hex = (value: unknown): string => {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)) return value;
  throw new Error(`Expected an ObjectId, found ${JSON.stringify(value)}`);
};

const hexOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : hex(value);

const dateOrNull = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  throw new Error(`Expected a date, found ${JSON.stringify(value)}`);
};

const dateOr = (value: unknown, fallback: Date): Date => dateOrNull(value) ?? fallback;

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const boolOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const boolOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/**
 * A nested value made safe for JSONB.
 *
 * Slide configs, snapshots and answer payloads were stored as opaque
 * objects, so they may hold BSON types JSON has no word for. ObjectIds
 * become their hex string and dates their ISO text -- the same thing the
 * API already sent to the browser for them.
 */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);

  if (typeof value === 'object') {
    const bsonType = (value as { _bsontype?: string })._bsontype;
    if (
      bsonType === 'Decimal128' ||
      bsonType === 'Long' ||
      bsonType === 'Int32' ||
      bsonType === 'Double'
    ) {
      // Each of these BSON wrappers prints as its plain numeric value.
      return Number((value as { toString: () => string }).toString());
    }

    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (inner !== undefined) out[key] = plain(inner);
    }
    return out;
  }

  return value;
}

const plainObject = (value: unknown): Record<string, unknown> => {
  const result = plain(value);
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
};

/* ------------------------------------------------------------------ */
/* Mapping each collection                                             */
/* ------------------------------------------------------------------ */

type UserRow = typeof users.$inferInsert;
type IdentityRow = typeof userIdentities.$inferInsert;
type TokenRow = typeof refreshTokens.$inferInsert;
type DeckRow = typeof decks.$inferInsert;
type SessionRow = typeof sessions.$inferInsert;
type ParticipantRow = typeof participants.$inferInsert;
type ResponseRow = typeof responses.$inferInsert;
type QuestionRow = typeof audienceQuestions.$inferInsert;

function mapUser(doc: Document): { user: UserRow; identities: IdentityRow[] } {
  const id = hex(doc._id);
  const created = dateOr(doc.createdAt, new Date());
  const hash = str(doc.passwordHash);

  return {
    user: {
      id,
      email: str(doc.email).trim().toLowerCase(),
      passwordHash: hash === '' ? null : hash,
      name: str(doc.name, 'User'),
      avatarUrl: str(doc.avatarUrl),
      locale: str(doc.locale, 'en'),
      emailVerifiedAt: dateOrNull(doc.emailVerifiedAt),
      tokenVersion: num(doc.tokenVersion),
      role: doc.role === 'admin' ? 'admin' : 'user',
      suspendedAt: dateOrNull(doc.suspendedAt),
      suspendedReason: str(doc.suspendedReason),
      aiRequestsToday: num(doc.aiRequestsToday),
      aiRequestsResetAt: dateOrNull(doc.aiRequestsResetAt),
      lastSeenAt: dateOrNull(doc.lastSeenAt),
      deletedAt: dateOrNull(doc.deletedAt),
      createdAt: created,
      updatedAt: dateOr(doc.updatedAt, created),
    },
    identities: (Array.isArray(doc.identities) ? (doc.identities as Document[]) : []).map(
      (identity) => ({
        provider: 'google' as const,
        subject: str(identity.subject),
        userId: id,
        email: str(identity.email),
        linkedAt: dateOr(identity.linkedAt, created),
      }),
    ),
  };
}

function mapToken(doc: Document): TokenRow {
  return {
    id: hex(doc._id),
    userId: hex(doc.userId),
    tokenHash: str(doc.tokenHash),
    family: str(doc.family),
    usedAt: dateOrNull(doc.usedAt),
    revokedAt: dateOrNull(doc.revokedAt),
    revokedReason: strOrNull(doc.revokedReason) as TokenRow['revokedReason'],
    expiresAt: dateOr(doc.expiresAt, new Date()),
    userAgent: str(doc.userAgent),
    ipHash: str(doc.ipHash),
    createdAt: dateOr(doc.createdAt, new Date()),
  };
}

function mapSlides(value: unknown): StoredSlide[] {
  return (Array.isArray(value) ? (value as Document[]) : []).map((slide) => ({
    id: str(slide.id),
    kind: str(slide.kind),
    position: num(slide.position),
    config: plainObject(slide.config),
  }));
}

function mapDeck(doc: Document): DeckRow {
  const created = dateOr(doc.createdAt, new Date());

  return {
    id: hex(doc._id),
    ownerId: hex(doc.ownerId),
    title: str(doc.title, 'Untitled'),
    description: str(doc.description),
    slides: mapSlides(doc.slides),
    theme: { ...DEFAULT_THEME, ...(plainObject(doc.theme) as Partial<DeckTheme>) },
    settings: { ...DEFAULT_SETTINGS, ...(plainObject(doc.settings) as Partial<DeckSettings>) },
    tags: Array.isArray(doc.tags)
      ? (doc.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    revision: num(doc.revision, 1),
    archivedAt: dateOrNull(doc.archivedAt),
    deletedAt: dateOrNull(doc.deletedAt),
    createdAt: created,
    updatedAt: dateOr(doc.updatedAt, created),
  };
}

function mapSession(doc: Document, knownDecks: Set<string>): SessionRow {
  const created = dateOr(doc.createdAt, new Date());
  const stats = (doc.stats ?? {}) as Document;
  const snapshot = plainObject(doc.deckSnapshot);
  const deckId = hexOrNull(doc.deckId);

  return {
    id: hex(doc._id),
    // A session whose deck has since gone keeps its history, with no deck.
    deckId: deckId !== null && knownDecks.has(deckId) ? deckId : null,
    ownerId: hex(doc.ownerId),
    title: str(doc.title, 'Session'),
    joinCode: str(doc.joinCode),
    joinSlug: str(doc.joinSlug),
    state: str(doc.state, 'closed') as SessionRow['state'],
    mode: str(doc.mode, 'presenter_paced') as SessionRow['mode'],
    deckSnapshot: {
      title: str(snapshot.title),
      slides: mapSlides(snapshot.slides),
      ...(snapshot.theme ? { theme: snapshot.theme as Record<string, unknown> } : {}),
      ...(snapshot.settings ? { settings: snapshot.settings as Record<string, unknown> } : {}),
    },
    currentSlideId: strOrNull(doc.currentSlideId),
    participationOpen: boolOr(doc.participationOpen, true),
    resultsVisible: boolOr(doc.resultsVisible, true),
    countdownStartedAt: dateOrNull(doc.countdownStartedAt),
    countdownSlideId: strOrNull(doc.countdownSlideId),
    participantCount: num(stats.participantCount),
    responseCount: num(stats.responseCount),
    peakConcurrent: num(stats.peakConcurrent),
    startedAt: dateOr(doc.startedAt, created),
    endedAt: dateOrNull(doc.endedAt),
    retentionUntil: dateOrNull(doc.retentionUntil),
    createdAt: created,
    updatedAt: dateOr(doc.updatedAt, created),
  };
}

function mapParticipant(doc: Document): ParticipantRow {
  const first = dateOr(doc.firstSeenAt, new Date());
  return {
    id: hex(doc._id),
    sessionId: hex(doc.sessionId),
    deviceToken: str(doc.deviceToken),
    displayName: str(doc.displayName),
    userId: hexOrNull(doc.userId),
    locale: str(doc.locale, 'en'),
    score: num(doc.score),
    currentSlideId: strOrNull(doc.currentSlideId),
    firstSeenAt: first,
    lastSeenAt: dateOr(doc.lastSeenAt, first),
    blockedAt: dateOrNull(doc.blockedAt),
  };
}

function mapResponse(doc: Document): ResponseRow {
  return {
    id: hex(doc._id),
    sessionId: hex(doc.sessionId),
    slideId: str(doc.slideId),
    participantId: hex(doc.participantId),
    kind: str(doc.kind),
    payload: plainObject(doc.payload),
    clientMsgId: str(doc.clientMsgId),
    isCorrect: boolOrNull(doc.isCorrect),
    points: numOrNull(doc.points),
    elapsedMs: numOrNull(doc.elapsedMs),
    upvotes: num(doc.upvotes),
    deletedAt: dateOrNull(doc.deletedAt),
    deletedReason: strOrNull(doc.deletedReason) as ResponseRow['deletedReason'],
    submittedAt: dateOr(doc.submittedAt, new Date()),
  };
}

function mapQuestion(doc: Document): QuestionRow {
  return {
    id: hex(doc._id),
    sessionId: hex(doc.sessionId),
    participantId: hex(doc.participantId),
    body: str(doc.body),
    authorName: str(doc.authorName),
    upvotes: num(doc.upvotes),
    status: str(doc.status, 'approved') as QuestionRow['status'],
    pinnedAt: dateOrNull(doc.pinnedAt),
    clientMsgId: str(doc.clientMsgId),
    createdAt: dateOr(doc.createdAt, new Date()),
    answeredAt: dateOrNull(doc.answeredAt),
  };
}

/* ------------------------------------------------------------------ */
/* Comparing what arrived with what was sent                           */
/* ------------------------------------------------------------------ */

/**
 * A value in a form that compares equal whichever database it came from.
 *
 * Dates compare by instant, and object keys by name rather than by the order
 * they happen to be stored in -- JSONB does not keep key order, and two
 * identical configs must not be reported as different because of it.
 */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value ?? null;
}

interface Difference {
  table: string;
  id: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

function compareRows(
  table: string,
  keyOf: (row: Record<string, unknown>) => string,
  expected: Record<string, unknown>[],
  actual: Record<string, unknown>[],
): Difference[] {
  const differences: Difference[] = [];
  const found = new Map(actual.map((row) => [keyOf(row), row]));

  for (const row of expected) {
    const key = keyOf(row);
    const stored = found.get(key);

    if (!stored) {
      differences.push({ table, id: key, field: '(row)', expected: 'present', actual: 'missing' });
      continue;
    }

    for (const [field, value] of Object.entries(row)) {
      const a = JSON.stringify(canonical(value));
      const b = JSON.stringify(canonical(stored[field]));
      if (a !== b)
        differences.push({ table, id: key, field, expected: value, actual: stored[field] });
    }

    found.delete(key);
  }

  for (const key of found.keys()) {
    differences.push({ table, id: key, field: '(row)', expected: 'absent', actual: 'unexpected' });
  }

  return differences;
}

/* ------------------------------------------------------------------ */
/* Comparing what arrived with the original documents                  */
/* ------------------------------------------------------------------ */

/*
 * The comparison above proves Postgres stored exactly what this script sent.
 * It cannot prove the script sent the right thing: if a converter dropped a
 * field, the converted row and the stored row would agree about the loss.
 *
 * So everything is checked a second time, against the raw MongoDB documents
 * and none of the converters above. Every deliberate difference between the
 * two shapes is written down in the specs below -- a renamed field, a default
 * for a field older documents lack, a nested object flattened into columns.
 * Anything not written down that differs is a failure, including a field in
 * a document that has nowhere to go.
 */

interface SourceSpec {
  table: string;
  /** Column name to document path, where they differ. */
  from?: Record<string, string>;
  /** What a column holds when an older document lacks the field. */
  /** A plain value, or a function of the document for defaults that depend on it. */
  missing?: Record<string, unknown>;
  /** Deliberate changes on the way in. */
  expect?: Record<string, (raw: unknown, doc: Document) => unknown>;
  /** Document fields with no column, each for a stated reason. */
  dropped?: string[];
  /** Fields that may only be dropped if they hold nothing. */
  droppedIfEmpty?: string[];
}

const pathOf = (doc: Document, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Document)[key] : undefined),
      doc,
    );

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonical(plain(a))) === JSON.stringify(canonical(plain(b)));

function verifyAgainstSource(
  spec: SourceSpec,
  docs: Document[],
  rows: Record<string, unknown>[],
  skippedIds: Set<string>,
): Difference[] {
  const differences: Difference[] = [];
  const rowById = new Map(rows.map((row) => [String(row.id), row]));
  const consumed = new Set([
    ...Object.values(spec.from ?? {}),
    ...(spec.dropped ?? []),
    '_id',
    '__v',
  ]);

  for (const doc of docs) {
    const id = hex(doc._id);
    const row = rowById.get(id);

    if (!row) {
      if (!skippedIds.has(id)) {
        differences.push({
          table: spec.table,
          id,
          field: '(row)',
          expected: 'copied',
          actual: 'missing',
        });
      }
      continue;
    }
    rowById.delete(id);

    for (const [column, actual] of Object.entries(row)) {
      const path = spec.from?.[column] ?? (column === 'id' ? '_id' : column);
      consumed.add(path.split('.')[0] ?? path);
      const raw = pathOf(doc, path);

      let expected: unknown;

      if (raw === undefined) {
        if (!spec.missing || !(column in spec.missing)) {
          differences.push({
            table: spec.table,
            id,
            field: column,
            expected: '(field absent, no stated default)',
            actual,
          });
          continue;
        }
        const fallback = spec.missing[column];
        expected =
          typeof fallback === 'function' ? (fallback as (d: Document) => unknown)(doc) : fallback;
      } else {
        expected = spec.expect?.[column] ? spec.expect[column](raw, doc) : raw;
      }

      if (!same(expected, actual)) {
        differences.push({ table: spec.table, id, field: column, expected, actual });
      }
    }

    // Nothing in the document may be left behind without a stated reason.
    for (const [key, value] of Object.entries(doc)) {
      const nested = Object.values(spec.from ?? {}).filter((p) => p.startsWith(`${key}.`));

      if (nested.length > 0 && value && typeof value === 'object') {
        for (const inner of Object.keys(value as Document)) {
          if (!nested.includes(`${key}.${inner}`)) {
            differences.push({
              table: spec.table,
              id,
              field: `${key}.${inner}`,
              expected: 'a column',
              actual: 'would be lost',
            });
          }
        }
        continue;
      }

      if (consumed.has(key)) continue;

      if (spec.droppedIfEmpty?.includes(key)) {
        if (value !== null && value !== undefined) {
          differences.push({ table: spec.table, id, field: key, expected: 'empty', actual: value });
        }
        continue;
      }

      if (!(key in row)) {
        differences.push({
          table: spec.table,
          id,
          field: key,
          expected: 'a column',
          actual: 'would be lost',
        });
      }
    }
  }

  for (const id of rowById.keys()) {
    differences.push({
      table: spec.table,
      id,
      field: '(row)',
      expected: 'absent',
      actual: 'not in MongoDB',
    });
  }

  return differences;
}

const createdAtOf = (doc: Document): unknown => doc.createdAt;

const SPECS: Record<string, SourceSpec> = {
  users: {
    table: 'users',
    // hasPassword is computed by Postgres; identities have their own table
    // and are checked separately below.
    dropped: ['hasPassword', 'identities'],
    expect: {
      email: (raw) => String(raw).trim().toLowerCase(),
      passwordHash: (raw) => (raw === '' ? null : raw),
    },
    missing: {
      passwordHash: null,
      avatarUrl: '',
      locale: 'en',
      emailVerifiedAt: null,
      tokenVersion: 0,
      role: 'user',
      suspendedAt: null,
      suspendedReason: '',
      aiRequestsToday: 0,
      aiRequestsResetAt: null,
      lastSeenAt: null,
      deletedAt: null,
      updatedAt: createdAtOf,
    },
  },
  refresh_tokens: {
    table: 'refresh_tokens',
    missing: { usedAt: null, revokedAt: null, revokedReason: null, userAgent: '', ipHash: '' },
  },
  decks: {
    table: 'decks',
    // References to organisations and folders, which never existed as
    // features; safe to leave behind only because nothing was ever in them.
    droppedIfEmpty: ['organizationId', 'folderId'],
    expect: {
      theme: (raw) => ({ ...DEFAULT_THEME, ...(raw as object) }),
      settings: (raw) => ({ ...DEFAULT_SETTINGS, ...(raw as object) }),
    },
    missing: {
      description: '',
      slides: [],
      theme: DEFAULT_THEME,
      settings: DEFAULT_SETTINGS,
      tags: [],
      revision: 1,
      archivedAt: null,
      deletedAt: null,
      updatedAt: createdAtOf,
    },
  },
  sessions: {
    table: 'sessions',
    from: {
      participantCount: 'stats.participantCount',
      responseCount: 'stats.responseCount',
      peakConcurrent: 'stats.peakConcurrent',
    },
    droppedIfEmpty: ['organizationId'],
    missing: {
      currentSlideId: null,
      participationOpen: true,
      resultsVisible: true,
      countdownStartedAt: null,
      countdownSlideId: null,
      participantCount: 0,
      responseCount: 0,
      peakConcurrent: 0,
      endedAt: null,
      retentionUntil: null,
      updatedAt: createdAtOf,
    },
  },
  participants: {
    table: 'participants',
    missing: {
      displayName: '',
      userId: null,
      locale: 'en',
      score: 0,
      currentSlideId: null,
      blockedAt: null,
      lastSeenAt: (doc: Document): unknown => doc.firstSeenAt as unknown,
    },
  },
  responses: {
    table: 'responses',
    missing: {
      isCorrect: null,
      points: null,
      elapsedMs: null,
      upvotes: 0,
      deletedAt: null,
      deletedReason: null,
    },
  },
  audience_questions: {
    table: 'audience_questions',
    missing: { authorName: '', upvotes: 0, status: 'approved', pinnedAt: null, answeredAt: null },
  },
};

/** Linked Google accounts, which were an array inside each user. */
function verifyIdentities(
  userDocs: Document[],
  rows: { userId: string; provider: string; subject: string; email: string; linkedAt: Date }[],
): Difference[] {
  const differences: Difference[] = [];
  const key = (i: { provider: unknown; subject: unknown; email?: unknown; linkedAt?: unknown }) =>
    JSON.stringify(
      canonical(
        plain({
          provider: i.provider,
          subject: i.subject,
          email: i.email ?? '',
          linkedAt: i.linkedAt,
        }),
      ),
    );

  for (const doc of userDocs) {
    const id = hex(doc._id);
    const original = (Array.isArray(doc.identities) ? (doc.identities as Document[]) : []).map(
      (i) => {
        for (const field of Object.keys(i)) {
          if (!['provider', 'subject', 'email', 'linkedAt', '_id'].includes(field)) {
            differences.push({
              table: 'user_identities',
              id,
              field,
              expected: 'a column',
              actual: 'would be lost',
            });
          }
        }
        return key(i as { provider: unknown; subject: unknown });
      },
    );
    const stored = rows.filter((r) => r.userId === id).map(key);

    if (JSON.stringify([...original].sort()) !== JSON.stringify([...stored].sort())) {
      differences.push({
        table: 'user_identities',
        id,
        field: '(identities)',
        expected: original,
        actual: stored,
      });
    }
  }

  return differences;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Inserts in batches.
 *
 * Postgres caps a statement at 65,535 parameters; 500 rows keeps even the
 * widest table here comfortably below that.
 */
async function insertAll<T extends Record<string, unknown>>(
  tx: Transaction,
  table: Parameters<Transaction['insert']>[0],
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    await tx.insert(table).values(rows.slice(i, i + 500));
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    say(`${R}MONGODB_URI is not set in .env.${X} It is only needed for this copy.`);
    process.exitCode = 1;
    return;
  }

  say(
    `\n${B}Copying MongoDB into PostgreSQL${X}${DRY_RUN ? `  ${Y}(dry run: nothing will be written)${X}` : ''}\n`,
  );

  const mongo = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 15_000,
    readPreference: 'primary',
  });
  await mongo.connect();
  await connectDb();

  try {
    const source = mongo.db();
    const read = (name: string) => source.collection(name).find({}).sort({ _id: 1 }).toArray();

    say(`${D}Reading MongoDB...${X}`);

    const [
      userDocs,
      tokenDocs,
      deckDocs,
      sessionDocs,
      participantDocs,
      responseDocs,
      questionDocs,
    ] = await Promise.all([
      read('users'),
      read('refreshtokens'),
      read('decks'),
      read('sessions'),
      read('participants'),
      read('responses'),
      read('audiencequestions'),
    ]);

    /* ---------------- map, skipping anything whose parent is gone ---------------- */

    const skipped: string[] = [];

    const mappedUsers = userDocs.map(mapUser);
    const userRows = mappedUsers.map((m) => m.user);
    const identityRows = mappedUsers.flatMap((m) => m.identities);
    const userIds = new Set(userRows.map((u) => u.id));

    const keepIf = <T>(rows: T[], ok: (row: T) => boolean, label: (row: T) => string): T[] =>
      rows.filter((row) => {
        if (ok(row)) return true;
        skipped.push(label(row));
        return false;
      });

    const tokenRows = keepIf(
      tokenDocs.map(mapToken),
      (t) => userIds.has(t.userId),
      (t) => `refresh token ${t.id} (its user no longer exists)`,
    );
    const deckRows = keepIf(
      deckDocs.map(mapDeck),
      (d) => userIds.has(d.ownerId),
      (d) => `deck ${d.id} (its owner no longer exists)`,
    );
    const deckIds = new Set(deckRows.map((d) => d.id));

    const sessionRows = keepIf(
      sessionDocs.map((d) => mapSession(d, deckIds)),
      (s) => userIds.has(s.ownerId),
      (s) => `session ${s.id} (its owner no longer exists)`,
    );
    const sessionIds = new Set(sessionRows.map((s) => s.id));

    const participantRows = keepIf(
      participantDocs.map(mapParticipant),
      (p) => sessionIds.has(p.sessionId),
      (p) => `participant ${p.id} (its session no longer exists)`,
    )
      // A participant tied to a deleted account stays, as the anonymous person they were.
      .map((p) => (p.userId && !userIds.has(p.userId) ? { ...p, userId: null } : p));
    const participantIds = new Set(participantRows.map((p) => p.id));

    const responseRows = keepIf(
      responseDocs.map(mapResponse),
      (r) => sessionIds.has(r.sessionId) && participantIds.has(r.participantId),
      (r) => `answer ${r.id} (its session or participant no longer exists)`,
    );
    const questionRows = keepIf(
      questionDocs.map(mapQuestion),
      (q) => sessionIds.has(q.sessionId) && participantIds.has(q.participantId),
      (q) => `question ${q.id} (its session or participant no longer exists)`,
    );

    /* ---------------- write and verify, all or nothing ---------------- */

    const report = await db
      .transaction(async (tx) => {
        const [existing] = await tx.select({ value: count() }).from(users);

        if ((existing?.value ?? 0) > 0) {
          if (!REPLACE) {
            throw new Error(
              'PostgreSQL already contains Pulse data. Nothing was written.\n' +
                '  To copy over it, run again with --replace. That removes what is in\n' +
                '  PostgreSQL first; MongoDB is still never touched.',
            );
          }

          say(`${Y}--replace: clearing existing PostgreSQL data first${X}`);
          await tx.execute(
            sql`TRUNCATE audience_questions, responses, participants, sessions, decks, refresh_tokens, user_identities, users`,
          );
        }

        say(`${D}Writing PostgreSQL...${X}`);

        await insertAll(tx, users, userRows);
        await insertAll(tx, userIdentities, identityRows);
        await insertAll(tx, refreshTokens, tokenRows);
        await insertAll(tx, decks, deckRows);
        await insertAll(tx, sessions, sessionRows);
        await insertAll(tx, participants, participantRows);
        await insertAll(tx, responses, responseRows);
        await insertAll(tx, audienceQuestions, questionRows);

        say(`${D}Reading every row back and comparing it with MongoDB...${X}`);

        // has_password is left out of the comparison: Postgres computes it,
        // so there is no copied value to check it against.
        const { hasPassword: _generated, ...userColumns } = getTableColumns(users);

        const differences = [
          ...compareRows(
            'users',
            (r) => String(r.id),
            userRows,
            await tx.select(userColumns).from(users).orderBy(asc(users.id)),
          ),
          ...compareRows(
            'user_identities',
            (r) => `${String(r.provider)}:${String(r.subject)}`,
            identityRows,
            await tx.select().from(userIdentities),
          ),
          ...compareRows(
            'refresh_tokens',
            (r) => String(r.id),
            tokenRows,
            await tx.select().from(refreshTokens),
          ),
          ...compareRows('decks', (r) => String(r.id), deckRows, await tx.select().from(decks)),
          ...compareRows(
            'sessions',
            (r) => String(r.id),
            sessionRows,
            await tx.select().from(sessions),
          ),
          ...compareRows(
            'participants',
            (r) => String(r.id),
            participantRows,
            await tx.select().from(participants),
          ),
          ...compareRows(
            'responses',
            (r) => String(r.id),
            responseRows,
            await tx.select().from(responses),
          ),
          ...compareRows(
            'audience_questions',
            (r) => String(r.id),
            questionRows,
            await tx.select().from(audienceQuestions),
          ),
        ];

        say(`${D}Checking every row against the original MongoDB documents...${X}`);

        const skippedIds = new Set(
          skipped.map((line) => line.split(' ').find((word) => /^[0-9a-f]{24}$/.test(word)) ?? ''),
        );

        differences.push(
          ...verifyAgainstSource(
            SPECS.users!,
            userDocs,
            await tx.select(userColumns).from(users),
            skippedIds,
          ),
          ...verifyIdentities(userDocs, await tx.select().from(userIdentities)),
          ...verifyAgainstSource(
            SPECS.refresh_tokens!,
            tokenDocs,
            await tx.select().from(refreshTokens),
            skippedIds,
          ),
          ...verifyAgainstSource(SPECS.decks!, deckDocs, await tx.select().from(decks), skippedIds),
          ...verifyAgainstSource(
            SPECS.sessions!,
            sessionDocs,
            await tx.select().from(sessions),
            skippedIds,
          ),
          ...verifyAgainstSource(
            SPECS.participants!,
            participantDocs,
            await tx.select().from(participants),
            skippedIds,
          ),
          ...verifyAgainstSource(
            SPECS.responses!,
            responseDocs,
            await tx.select().from(responses),
            skippedIds,
          ),
          ...verifyAgainstSource(
            SPECS.audience_questions!,
            questionDocs,
            await tx.select().from(audienceQuestions),
            skippedIds,
          ),
        );

        if (differences.length > 0) {
          say(
            `\n${R}${B}${String(differences.length)} difference(s) between MongoDB and PostgreSQL:${X}`,
          );
          for (const d of differences.slice(0, 25)) {
            say(
              `  ${d.table} ${d.id} ${B}${d.field}${X}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`,
            );
          }
          throw new Error(
            'Verification failed. Everything has been rolled back; PostgreSQL is unchanged.',
          );
        }

        /*
         * has_password is computed by Postgres rather than copied. Where it
         * disagrees with the flag MongoDB stored, the stored flag was the one
         * that was wrong -- which is exactly the bug the generated column
         * exists to rule out -- so this is reported, not treated as failure.
         */
        const derived = await tx
          .select({ id: users.id, hasPassword: users.hasPassword })
          .from(users);
        const derivedBy = new Map(derived.map((row) => [row.id, row.hasPassword]));
        const corrected = userDocs.filter(
          (doc) =>
            typeof doc.hasPassword === 'boolean' && derivedBy.get(hex(doc._id)) !== doc.hasPassword,
        ).length;

        const counts = {
          users: userRows.length,
          'linked Google accounts': identityRows.length,
          'refresh tokens': tokenRows.length,
          decks: deckRows.length,
          sessions: sessionRows.length,
          participants: participantRows.length,
          answers: responseRows.length,
          'audience questions': questionRows.length,
        };

        if (DRY_RUN) throw new DryRunComplete(JSON.stringify({ counts, corrected }));
        return { counts, corrected };
      })
      .catch((err: unknown) => {
        if (err instanceof DryRunComplete) {
          return {
            ...(JSON.parse(err.message) as { counts: Record<string, number>; corrected: number }),
            rolledBack: true,
          };
        }
        throw err;
      });

    /* ---------------- report ---------------- */

    say('');
    for (const [label, value] of Object.entries(report.counts)) {
      say(`  ${G}✓${X} ${String(value).padStart(5)}  ${label}`);
    }

    say(`\n  ${G}${B}Every row matches MongoDB, field for field.${X}`);

    if (report.corrected > 0) {
      say(
        `  ${Y}${String(report.corrected)} account(s) had a stale "has password" flag in MongoDB; PostgreSQL derives it correctly.${X}`,
      );
    }

    if (skipped.length > 0) {
      say(
        `\n  ${Y}${String(skipped.length)} record(s) not copied, because what they belonged to no longer exists:${X}`,
      );
      for (const line of skipped.slice(0, 20)) say(`    ${D}${line}${X}`);
    }

    if ('rolledBack' in report) {
      say(`\n  ${Y}${B}Dry run: all of that was rolled back.${X} Nothing was written.`);
      say(`  Run again without --dry-run to copy for real.\n`);
    } else {
      say(`\n  ${G}${B}Copied.${X} MongoDB was not modified and still holds the originals.\n`);
    }
  } finally {
    await mongo.close();
    await disconnectDb();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(
    `\n${R}${B}Stopped.${X} ${message.replace(/(mongodb(\+srv)?|postgres(ql)?):\/\/[^\s@]*@/gi, '$1://***@')}\n\n`,
  );
  process.exitCode = 1;
});
