/**
 * Cleanup checks, against the real database.
 *
 * This job deletes data permanently, so the important assertions are the
 * negative ones: that a deck deleted yesterday survives, that a recent
 * session keeps its answers, and that a live session is left alone. An
 * off-by-one in a retention window is unrecoverable.
 *
 * Every row here is created by this script and removed at the end. The job
 * itself runs against the whole database, exactly as it does on a schedule,
 * so its rules are checked on the real thing rather than a copy.
 *
 *   npm run cleanup:verify -w server
 */
import { count, eq, inArray } from 'drizzle-orm';
import { connectDb, disconnectDb, db } from '../lib/db.js';
import { newId } from '../db/ids.js';
import {
  users,
  decks,
  sessions,
  participants,
  responses,
  refreshTokens,
  type SessionStateName,
} from '../db/schema.js';
import { runCleanup } from '../jobs/cleanup.js';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.stdout.write(`  ${G}PASS${X}  ${name}\n`);
    passed += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ${R}FAIL${X}  ${name}\n        ${R}${message}${X}\n`);
    failed += 1;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY);

const random = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');

async function main(): Promise<void> {
  await connectDb();

  const stamp = Date.now();
  process.stdout.write(`\n${D}Cleanup checks${X}\n\n`);

  const ownerId = newId();
  await db.insert(users).values({
    id: ownerId,
    email: `cleanup-${String(stamp)}@example.test`,
    name: 'Cleanup Owner',
    passwordHash: 'x'.repeat(20),
  });

  const deckExists = async (id: string) =>
    (await db.select({ id: decks.id }).from(decks).where(eq(decks.id, id))).length > 0;

  const answersFor = async (sessionId: string) =>
    (
      await db.select({ value: count() }).from(responses).where(eq(responses.sessionId, sessionId))
    )[0]?.value ?? 0;

  /* ---------------- decks ---------------- */

  await check('a deck deleted 40 days ago is purged', async () => {
    const id = newId();
    await db.insert(decks).values({ id, ownerId, title: 'Old', deletedAt: daysAgo(40) });

    await runCleanup();

    assert(!(await deckExists(id)), 'the deck survived its grace period');
  });

  await check('a deck deleted yesterday survives', async () => {
    const id = newId();
    await db.insert(decks).values({ id, ownerId, title: 'Recent', deletedAt: daysAgo(1) });

    await runCleanup();

    assert(await deckExists(id), 'a recently deleted deck was purged too early');
  });

  await check('a deck that was never deleted is untouched', async () => {
    const id = newId();
    await db.insert(decks).values({ id, ownerId, title: 'Live deck' });

    await runCleanup();

    assert(await deckExists(id), 'an active deck was deleted');
  });

  await check('purging a deck keeps the sessions that presented it', async () => {
    const deckId = newId();
    await db
      .insert(decks)
      .values({ id: deckId, ownerId, title: 'Presented', deletedAt: daysAgo(40) });
    const session = await makeSession(ownerId, daysAgo(10), 'closed', deckId);

    await runCleanup();

    const [after] = await db.select().from(sessions).where(eq(sessions.id, session));
    assert(after, 'the session was deleted along with its deck');
    assert(after.deckId === null, 'the session still points at the purged deck');
    assert((await answersFor(session)) === 1, 'the session lost its answers with the deck');
  });

  /* ---------------- responses ---------------- */

  await check('answers from a session closed 400 days ago are purged', async () => {
    const session = await makeSession(ownerId, daysAgo(400));

    await runCleanup();

    assert((await answersFor(session)) === 0, 'old answers survived');

    const participantsLeft = await db
      .select({ value: count() })
      .from(participants)
      .where(eq(participants.sessionId, session));
    assert((participantsLeft[0]?.value ?? 0) === 0, 'old participants survived');

    // The session row itself stays, so the history page still shows it ran.
    const still = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, session));
    assert(still.length === 1, 'the session row was deleted along with its answers');
  });

  await check('answers from a session closed last month survive', async () => {
    const session = await makeSession(ownerId, daysAgo(30));

    await runCleanup();

    assert((await answersFor(session)) === 1, 'recent answers were purged');
  });

  await check('answers from a session that never ended survive', async () => {
    const session = await makeSession(ownerId, null, 'live');

    await runCleanup();

    assert((await answersFor(session)) === 1, 'answers from an open session were purged');
  });

  /* ---------------- stale sessions ---------------- */

  await check('a session left live for two days is closed', async () => {
    const id = await makeSession(ownerId, null, 'live', null, daysAgo(2));

    await runCleanup();

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    assert(after?.state === 'closed', 'an abandoned session stayed live');
    assert(after.endedAt !== null, 'it was closed without an end time');
  });

  await check('a session started an hour ago is left alone', async () => {
    const id = await makeSession(
      ownerId,
      null,
      'live',
      null,
      new Date(Date.now() - 60 * 60 * 1000),
    );

    await runCleanup();

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    assert(after?.state === 'live', 'a live session was closed while it was still running');
  });

  /* ---------------- tokens ---------------- */

  const tokenExists = async (id: string) =>
    (await db.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.id, id)))
      .length > 0;

  const makeToken = async (values: { expiresAt: Date; revokedAt?: Date }) => {
    const id = newId();
    await db.insert(refreshTokens).values({
      id,
      userId: ownerId,
      tokenHash: `h${random(40)}`,
      family: `f${random(20)}`,
      ...values,
    });
    return id;
  };

  await check('a token revoked long ago is purged', async () => {
    const id = await makeToken({ expiresAt: new Date(Date.now() + DAY), revokedAt: daysAgo(40) });

    await runCleanup();

    assert(!(await tokenExists(id)), 'an old revoked token survived');
  });

  await check('an expired token is purged', async () => {
    // MongoDB did this with a TTL index. Postgres has none, so without the
    // job the table would grow by a row on every refresh, forever.
    const id = await makeToken({ expiresAt: daysAgo(1) });

    await runCleanup();

    assert(!(await tokenExists(id)), 'an expired token survived');
  });

  await check('a recently revoked token is kept for reuse detection', async () => {
    // A revoked token presented again is how theft is noticed; purging it
    // immediately would blind that check.
    const id = await makeToken({ expiresAt: new Date(Date.now() + DAY), revokedAt: daysAgo(2) });

    await runCleanup();

    assert(await tokenExists(id), 'a recently revoked token was purged too early');
  });

  await check('a valid token is untouched', async () => {
    const id = await makeToken({ expiresAt: new Date(Date.now() + DAY) });

    await runCleanup();

    assert(await tokenExists(id), 'a valid token was deleted');
  });

  /* ---------------- idempotence ---------------- */

  await check('running twice changes nothing the second time', async () => {
    await runCleanup();
    const second = await runCleanup();

    const total =
      second.decksPurged +
      second.responsesPurged +
      second.participantsPurged +
      second.questionsPurged +
      second.tokensPurged +
      second.staleSessionsClosed +
      second.imagesPurged;

    assert(total === 0, `a second run still removed ${String(total)} rows`);
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up test data...${X}\n`);
  // Decks, sessions, participants, answers and tokens all go with the owner.
  await db.delete(users).where(inArray(users.id, [ownerId]));

  const summary =
    failed === 0
      ? `${G}${String(passed)} passed${X}`
      : `${R}${String(failed)} failed${X}, ${String(passed)} passed`;
  process.stdout.write(`\n  ${summary}\n\n`);

  await disconnectDb();
  if (failed > 0) process.exitCode = 1;
}

/** A session with one participant who has answered once. Returns its id. */
async function makeSession(
  ownerId: string,
  endedAt: Date | null,
  state: SessionStateName = 'closed',
  deckId: string | null = null,
  startedAt: Date = endedAt ?? new Date(),
): Promise<string> {
  const id = newId();

  await db.insert(sessions).values({
    id,
    deckId,
    ownerId,
    title: 'Session',
    // Closed sessions may share codes; live ones may not, so live test
    // sessions get a code nothing real is likely to hold.
    joinCode: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
    joinSlug: `slug${random(10)}`,
    state,
    mode: 'presenter_paced',
    deckSnapshot: { title: 'S', slides: [] },
    startedAt,
    endedAt,
  });

  const participantId = newId();
  await db
    .insert(participants)
    .values({ id: participantId, sessionId: id, deviceToken: `d${random(20)}` });

  await db.insert(responses).values({
    id: newId(),
    sessionId: id,
    slideId: 'slide-1',
    participantId,
    kind: 'word_cloud',
    payload: { kind: 'word_cloud', words: ['hello'] },
    clientMsgId: `m${random(20)}`,
  });

  return id;
}

void main().catch(async (err: unknown) => {
  process.stdout.write(`${R}The run itself failed: ${String(err)}${X}\n`);
  await disconnectDb().catch(() => undefined);
  process.exitCode = 1;
});
