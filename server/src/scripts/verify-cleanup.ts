/**
 * Cleanup checks, against the real database.
 *
 * This job deletes data permanently, so the important assertions are the
 * negative ones: that a deck deleted yesterday survives, that a recent
 * session keeps its answers, and that a live session is left alone. An
 * off-by-one in a retention window is unrecoverable.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { Deck, Session, Response, Participant, User, RefreshToken } from '../models/index.js';
import { runCleanup } from '../jobs/cleanup.js';
import { Types } from 'mongoose';

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

async function main(): Promise<void> {
  await connectDb();

  const stamp = Date.now();
  process.stdout.write(`\n${D}Cleanup checks${X}\n\n`);

  const owner = await User.create({
    email: `cleanup-${String(stamp)}@example.test`,
    name: 'Cleanup Owner',
    passwordHash: 'x'.repeat(20),
  });

  const created: { decks: Types.ObjectId[]; sessions: Types.ObjectId[] } = {
    decks: [],
    sessions: [],
  };

  /* ---------------- decks ---------------- */

  await check('a deck deleted 40 days ago is purged', async () => {
    const deck = await Deck.create({
      ownerId: owner._id,
      title: 'Old',
      deletedAt: daysAgo(40),
    });

    await runCleanup();

    const still = await Deck.findById(deck._id).lean();
    assert(still === null, 'the deck survived its grace period');
  });

  await check('a deck deleted yesterday survives', async () => {
    const deck = await Deck.create({
      ownerId: owner._id,
      title: 'Recent',
      deletedAt: daysAgo(1),
    });
    created.decks.push(deck._id);

    await runCleanup();

    const still = await Deck.findById(deck._id).lean();
    assert(still !== null, 'a recently deleted deck was purged too early');
  });

  await check('a deck that was never deleted is untouched', async () => {
    const deck = await Deck.create({ ownerId: owner._id, title: 'Live deck' });
    created.decks.push(deck._id);

    await runCleanup();

    const still = await Deck.findById(deck._id).lean();
    assert(still !== null, 'an active deck was deleted');
  });

  /* ---------------- responses ---------------- */

  const makeSession = async (endedAt: Date | null, state = 'closed') => {
    const session = await Session.create({
      deckId: new Types.ObjectId(),
      ownerId: owner._id,
      title: 'Session',
      joinCode: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
      joinSlug: `slug${String(Math.random()).slice(2, 10)}`,
      state,
      mode: 'presenter_paced',
      deckSnapshot: { title: 'S', slides: [] },
      startedAt: endedAt ?? new Date(),
      endedAt,
    });
    created.sessions.push(session._id);

    const participant = await Participant.create({
      sessionId: session._id,
      deviceToken: `d${String(Math.random()).slice(2, 20)}`,
    });

    await Response.create({
      sessionId: session._id,
      slideId: 'slide-1',
      participantId: participant._id,
      kind: 'word_cloud',
      payload: { kind: 'word_cloud', words: ['hello'] },
      clientMsgId: `m${String(Math.random()).slice(2, 20)}`,
    });

    return session;
  };

  await check('answers from a session closed 400 days ago are purged', async () => {
    const session = await makeSession(daysAgo(400));

    await runCleanup();

    const responses = await Response.countDocuments({ sessionId: session._id });
    assert(responses === 0, 'old answers survived');

    // The session row itself stays, so the history page still shows it ran.
    const still = await Session.findById(session._id).lean();
    assert(still !== null, 'the session row was deleted along with its answers');
  });

  await check('answers from a session closed last month survive', async () => {
    const session = await makeSession(daysAgo(30));

    await runCleanup();

    const responses = await Response.countDocuments({ sessionId: session._id });
    assert(responses === 1, 'recent answers were purged');
  });

  await check('answers from a session that never ended survive', async () => {
    const session = await makeSession(null, 'live');

    await runCleanup();

    const responses = await Response.countDocuments({ sessionId: session._id });
    assert(responses === 1, 'answers from an open session were purged');
  });

  /* ---------------- stale sessions ---------------- */

  await check('a session left live for two days is closed', async () => {
    const session = await Session.create({
      deckId: new Types.ObjectId(),
      ownerId: owner._id,
      title: 'Abandoned',
      joinCode: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
      joinSlug: `slug${String(Math.random()).slice(2, 10)}`,
      state: 'live',
      mode: 'presenter_paced',
      deckSnapshot: { title: 'S', slides: [] },
      startedAt: daysAgo(2),
    });
    created.sessions.push(session._id);

    await runCleanup();

    const after = await Session.findById(session._id).lean();
    assert(after?.state === 'closed', 'an abandoned session stayed live');
    assert(after.endedAt !== null, 'it was closed without an end time');
  });

  await check('a session started an hour ago is left alone', async () => {
    const session = await Session.create({
      deckId: new Types.ObjectId(),
      ownerId: owner._id,
      title: 'Running',
      joinCode: String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'),
      joinSlug: `slug${String(Math.random()).slice(2, 10)}`,
      state: 'live',
      mode: 'presenter_paced',
      deckSnapshot: { title: 'S', slides: [] },
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    created.sessions.push(session._id);

    await runCleanup();

    const after = await Session.findById(session._id).lean();
    assert(after?.state === 'live', 'a live session was closed while it was still running');
  });

  /* ---------------- tokens ---------------- */

  await check('a token revoked long ago is purged', async () => {
    const token = await RefreshToken.create({
      userId: owner._id,
      tokenHash: `h${String(Math.random()).slice(2, 30)}`,
      family: `f${String(Math.random()).slice(2, 20)}`,
      expiresAt: new Date(Date.now() + DAY),
      revokedAt: daysAgo(40),
    });

    await runCleanup();

    const still = await RefreshToken.findById(token._id).lean();
    assert(still === null, 'an old revoked token survived');
  });

  await check('a valid token is untouched', async () => {
    const token = await RefreshToken.create({
      userId: owner._id,
      tokenHash: `h${String(Math.random()).slice(2, 30)}`,
      family: `f${String(Math.random()).slice(2, 20)}`,
      expiresAt: new Date(Date.now() + DAY),
    });

    await runCleanup();

    const still = await RefreshToken.findById(token._id).lean();
    assert(still !== null, 'a valid token was deleted');
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
      second.staleSessionsClosed;

    assert(total === 0, `a second run still removed ${String(total)} rows`);
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up test data...${X}\n`);
  await Response.deleteMany({ sessionId: { $in: created.sessions } });
  await Participant.deleteMany({ sessionId: { $in: created.sessions } });
  await Session.deleteMany({ _id: { $in: created.sessions } });
  await Deck.deleteMany({ _id: { $in: created.decks } });
  await RefreshToken.deleteMany({ userId: owner._id });
  await User.deleteOne({ _id: owner._id });

  const summary =
    failed === 0
      ? `${G}${String(passed)} passed${X}`
      : `${R}${String(failed)} failed${X}, ${String(passed)} passed`;
  process.stdout.write(`\n  ${summary}\n\n`);

  await disconnectDb();
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  process.stdout.write(`${R}The run itself failed: ${String(err)}${X}\n`);
  process.exitCode = 1;
});
