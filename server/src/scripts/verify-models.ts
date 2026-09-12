/**
 * Exercises every model against the real database, then cleans up after
 * itself. This is a smoke test for the schema layer: it proves indexes
 * build, constraints bite, and the guarantees we rely on actually hold.
 *
 *   npm run db:verify -w server
 */
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';
import { User, Deck, Session, Participant, Response, AudienceQuestion } from '../models/index.js';
import { SLIDE_REGISTRY } from '@pulse/shared';

const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ${G}PASS${X}  ${label}\n`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ${R}FAIL${X}  ${label}\n        ${D}${msg}${X}\n`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  await connectDb();
  process.stdout.write(`\n${B}Verifying models against the live database${X}\n\n`);

  const stamp = Date.now();
  const email = `verify-${stamp}@example.test`;

  /* ---------------- User ---------------- */

  const user = await User.create({
    email,
    passwordHash: 'not-a-real-hash',
    name: 'Verification User',
  });

  await check('User is created and stored', () => {
    assert(user._id, 'no id assigned');
    assert(user.email === email, 'email not normalised as expected');
  });

  await check('passwordHash is never returned by default', async () => {
    const fetched = await User.findById(user._id).lean();
    assert(fetched, 'user not found');
    assert(!('passwordHash' in fetched), 'passwordHash leaked into a normal query');
  });

  await check('passwordHash is available when explicitly requested', async () => {
    const withHash = await User.findById(user._id).select('+passwordHash').lean();
    assert(withHash?.passwordHash === 'not-a-real-hash', 'hash not retrievable on demand');
  });

  await check('duplicate email is rejected', async () => {
    try {
      await User.create({ email, passwordHash: 'x', name: 'Impostor' });
      throw new Error('a second account with the same email was allowed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      assert(/duplicate key|E11000/i.test(msg), `expected a duplicate key error, got: ${msg}`);
    }
  });

  await check('toJSON strips the password hash', () => {
    const json = JSON.parse(JSON.stringify(user)) as Record<string, unknown>;
    assert(!('passwordHash' in json), 'passwordHash present after serialisation');
    assert(!('__v' in json), '__v present after serialisation');
  });

  /* ---------------- Deck ---------------- */

  const mc = SLIDE_REGISTRY.multiple_choice.defaults();
  const wc = SLIDE_REGISTRY.word_cloud.defaults();

  const deck = await Deck.create({
    ownerId: user._id,
    title: 'Verification Deck',
    slides: [
      { id: 's1', kind: 'multiple_choice', position: 1000, config: mc },
      { id: 's2', kind: 'word_cloud', position: 2000, config: wc },
    ],
  });

  await check('Deck stores embedded slides with their config', async () => {
    const fetched = await Deck.findById(deck._id).lean();
    assert(fetched?.slides.length === 2, 'expected two slides');
    const first = fetched.slides[0];
    assert(first?.kind === 'multiple_choice', 'slide kind not stored');
    const cfg = first.config as { options?: unknown[] };
    assert(
      Array.isArray(cfg.options) && cfg.options.length === 3,
      'slide config not stored intact',
    );
  });

  await check('Deck applies its default theme and settings', async () => {
    const fetched = await Deck.findById(deck._id).lean();
    assert(fetched?.theme.mode === 'dark', 'theme default missing');
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Mongoose types nested paths as possibly undefined; tsc requires the guard.
    assert(fetched?.settings?.mode === 'presenter_paced', 'settings default missing');
    assert(fetched.settings.profanityFilter, 'profanity filter should default on');
  });

  await check('an unknown slide kind is rejected', async () => {
    try {
      await Deck.create({
        ownerId: user._id,
        title: 'Bad Deck',
        slides: [{ id: 'x', kind: 'not_a_real_kind', position: 1000, config: {} }],
      });
      throw new Error('an invalid slide kind was accepted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      assert(/validation|enum/i.test(msg), `expected a validation error, got: ${msg}`);
    }
  });

  /* ---------------- Session ---------------- */

  const session = await Session.create({
    deckId: deck._id,
    ownerId: user._id,
    title: deck.title,
    joinCode: String(100000 + (stamp % 900000)),
    joinSlug: `verify-${stamp}`,
    mode: 'presenter_paced',
    deckSnapshot: deck.toObject(),
    currentSlideId: 's1',
  });

  await check('Session freezes a copy of the deck', () => {
    const snap = session.deckSnapshot as { slides?: unknown[] };
    assert(
      Array.isArray(snap.slides) && snap.slides.length === 2,
      'snapshot did not capture slides',
    );
  });

  await check('editing the deck does not change the frozen snapshot', async () => {
    await Deck.updateOne({ _id: deck._id }, { $set: { title: 'Renamed After Session Started' } });
    const fresh = await Session.findById(session._id).lean();
    const snap = fresh?.deckSnapshot as { title?: string };
    assert(
      snap.title === 'Verification Deck',
      `snapshot changed with the deck — it now reads "${snap.title}"`,
    );
  });

  await check('a second live session cannot reuse a join code', async () => {
    try {
      await Session.create({
        deckId: deck._id,
        ownerId: user._id,
        title: 'Clash',
        joinCode: session.joinCode,
        joinSlug: `verify-clash-${stamp}`,
        mode: 'presenter_paced',
        deckSnapshot: {},
      });
      throw new Error('two live sessions shared a join code');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      assert(/duplicate key|E11000/i.test(msg), `expected a duplicate key error, got: ${msg}`);
    }
  });

  await check('a closed session releases its join code for reuse', async () => {
    await Session.updateOne({ _id: session._id }, { $set: { state: 'closed' } });
    const reused = await Session.create({
      deckId: deck._id,
      ownerId: user._id,
      title: 'Reuse',
      joinCode: session.joinCode,
      joinSlug: `verify-reuse-${stamp}`,
      mode: 'presenter_paced',
      deckSnapshot: {},
    });
    assert(reused._id, 'code was not reusable after the first session closed');
    await Session.deleteOne({ _id: reused._id });
    await Session.updateOne({ _id: session._id }, { $set: { state: 'live' } });
  });

  /* ---------------- Participant ---------------- */

  const participant = await Participant.create({
    sessionId: session._id,
    deviceToken: `device-${stamp}`,
  });

  await check('Participant joins a session', () => {
    assert(participant._id, 'no id assigned');
    assert(participant.score === 0, 'score should start at zero');
  });

  await check('the same device cannot join twice', async () => {
    try {
      await Participant.create({ sessionId: session._id, deviceToken: `device-${stamp}` });
      throw new Error('the same device created two participant rows');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      assert(/duplicate key|E11000/i.test(msg), `expected a duplicate key error, got: ${msg}`);
    }
  });

  /* ---------------- Response ---------------- */

  const answer = await Response.create({
    sessionId: session._id,
    slideId: 's1',
    participantId: participant._id,
    kind: 'multiple_choice',
    payload: { kind: 'multiple_choice', optionIds: ['o1'] },
    clientMsgId: `msg-${stamp}`,
  });

  await check('Response is recorded', () => {
    assert(answer._id, 'no id assigned');
    assert(answer.upvotes === 0, 'upvotes should start at zero');
  });

  await check('a retried submission is counted exactly once', async () => {
    try {
      await Response.create({
        sessionId: session._id,
        slideId: 's1',
        participantId: participant._id,
        kind: 'multiple_choice',
        payload: { kind: 'multiple_choice', optionIds: ['o2'] },
        clientMsgId: `msg-${stamp}`,
      });
      throw new Error('a duplicate clientMsgId was accepted — offline retries would double-count');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      assert(/duplicate key|E11000/i.test(msg), `expected a duplicate key error, got: ${msg}`);
    }
    const count = await Response.countDocuments({ sessionId: session._id, slideId: 's1' });
    assert(count === 1, `expected exactly 1 response, found ${count}`);
  });

  await check('a removed answer is hidden but not destroyed', async () => {
    await Response.updateOne(
      { _id: answer._id },
      { $set: { deletedAt: new Date(), deletedReason: 'presenter' } },
    );
    const live = await Response.countDocuments({ sessionId: session._id, deletedAt: null });
    const all = await Response.countDocuments({ sessionId: session._id });
    assert(live === 0, 'deleted answer still counted as live');
    assert(all === 1, 'deleted answer was destroyed rather than marked');
    await Response.updateOne(
      { _id: answer._id },
      { $set: { deletedAt: null, deletedReason: null } },
    );
  });

  /* ---------------- AudienceQuestion ---------------- */

  await check('AudienceQuestion is recorded and defaults to approved', async () => {
    const q = await AudienceQuestion.create({
      sessionId: session._id,
      participantId: participant._id,
      body: 'Will this be recorded?',
      clientMsgId: `q-${stamp}`,
    });
    assert(q.status === 'approved', 'expected approved by default when unmoderated');
    assert(q.upvotes === 0, 'upvotes should start at zero');
  });

  /* ---------------- indexes ---------------- */

  await check('every declared index exists on the server', async () => {
    const expectations: [string, number][] = [
      ['users', 2],
      ['decks', 3],
      ['sessions', 4],
      ['participants', 2],
      ['responses', 5],
      ['audiencequestions', 2],
    ];
    for (const [name, minimum] of expectations) {
      const idx = await mongoose.connection.db!.collection(name).indexes();
      assert(
        idx.length >= minimum,
        `${name} has ${idx.length} indexes, expected at least ${minimum}`,
      );
    }
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up test data...${X}\n`);
  await Promise.all([
    User.deleteMany({ email }),
    Deck.deleteMany({ ownerId: user._id }),
    Session.deleteMany({ ownerId: user._id }),
    Participant.deleteMany({ sessionId: session._id }),
    Response.deleteMany({ sessionId: session._id }),
    AudienceQuestion.deleteMany({ sessionId: session._id }),
  ]);

  const leftover = await User.countDocuments({ email });
  if (leftover > 0) throw new Error('cleanup did not remove the test user');

  process.stdout.write(
    `\n  ${passed > 0 ? G : D}${passed} passed${X}` +
      (failed > 0 ? `   ${R}${B}${failed} failed${X}` : '') +
      '\n\n',
  );

  await disconnectDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n${R}${B}Verification crashed${X}\n${String(err)}\n\n`);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
