/**
 * Exercises the schema against the real database, then cleans up after
 * itself. It proves the guarantees the rest of the server relies on are
 * enforced by PostgreSQL itself -- not merely by code that could be bypassed.
 *
 *   npm run db:verify -w server
 *
 * Most checks deliberately write something the database must refuse. A
 * constraint that exists only on paper passes every test that never tries
 * to break it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { connectDb, disconnectDb, db, isUniqueViolation } from '../lib/db.js';
import { newId, isId } from '../db/ids.js';
import {
  users,
  userIdentities,
  decks,
  sessions,
  participants,
  responses,
  audienceQuestions,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
} from '../db/schema.js';
import * as deckService from '../services/decks.js';
import * as sessionService from '../services/sessions.js';
import { consumeQuota, DAILY_AI_LIMIT } from '../services/ai/features.js';
import { HttpError } from '../app.js';
import { SLIDE_REGISTRY, type SlideKind } from '@pulse/shared';

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

/** The Postgres error code behind a failed statement, however Drizzle wrapped it. */
function pgCode(err: unknown): string | undefined {
  for (let current: unknown = err, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Runs a write the database must refuse, and checks it refused for the right reason. */
async function mustFail(write: () => Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await write();
  } catch (err) {
    const actual = pgCode(err);
    assert(
      actual === code,
      `${what}: expected Postgres error ${code}, got ${actual ?? String(err)}`,
    );
    return;
  }
  throw new Error(`${what} was accepted`);
}

/**
 * Whether two values hold the same content.
 *
 * JSONB stores object keys in its own order, not the order they were written
 * in, so comparing JSON text reports identical objects as different.
 */
function sameContent(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const CHECK = '23514';
const GENERATED = '428C9';

async function main() {
  await connectDb();
  process.stdout.write(`\n${B}Verifying the schema against the live database${X}\n\n`);

  const stamp = Date.now();
  const email = `verify-${String(stamp)}@example.test`;
  const userIds: string[] = [];

  /* ---------------- ids ---------------- */

  await check('new ids have the MongoDB shape and sort by creation time', () => {
    const first = newId();
    const second = newId();
    assert(isId(first) && isId(second), 'an id is not 24 hex characters');
    assert(first !== second, 'two ids collided');
    assert(first.slice(0, 8) <= second.slice(0, 8), 'ids do not sort by creation time');
  });

  /* ---------------- users ---------------- */

  const userId = newId();
  userIds.push(userId);

  const [user] = await db
    .insert(users)
    .values({ id: userId, email, passwordHash: 'not-a-real-hash', name: 'Verification User' })
    .returning();

  await check('a user is created with every default applied', () => {
    assert(user, 'insert returned nothing');
    assert(user.role === 'user', `role defaulted to ${user.role}`);
    assert(user.tokenVersion === 0, 'tokenVersion did not default to 0');
    assert(user.locale === 'en', 'locale did not default');
    assert(user.suspendedAt === null && user.deletedAt === null, 'nullable dates are not null');
  });

  await check('has_password is derived from the hash, in both directions', async () => {
    assert(user?.hasPassword === true, 'a user with a hash reads as having no password');

    const [cleared] = await db
      .update(users)
      .set({ passwordHash: null })
      .where(eq(users.id, userId))
      .returning({ hasPassword: users.hasPassword });
    assert(cleared?.hasPassword === false, 'clearing the hash left has_password true');

    const [restored] = await db
      .update(users)
      .set({ passwordHash: 'not-a-real-hash' })
      .where(eq(users.id, userId))
      .returning({ hasPassword: users.hasPassword });
    assert(restored?.hasPassword === true, 'setting the hash left has_password false');
  });

  await check('has_password cannot be written directly', async () => {
    // The whole point of the generated column: nothing can make it lie.
    await mustFail(
      () => db.execute(sql`UPDATE users SET has_password = false WHERE id = ${userId}`),
      GENERATED,
      'writing has_password',
    );
  });

  await check('a duplicate email is rejected', async () => {
    await mustFail(
      () => db.insert(users).values({ id: newId(), email, name: 'Impostor' }),
      UNIQUE,
      'a second account with the same email',
    );
  });

  await check('a mixed-case email cannot be stored', async () => {
    // Logins look addresses up lowercased; one stored any other way would
    // exist but never be found.
    await mustFail(
      () =>
        db
          .insert(users)
          .values({ id: newId(), email: `Mixed-${String(stamp)}@Example.test`, name: 'X' }),
      CHECK,
      'a mixed-case email',
    );
  });

  await check('an invalid role is rejected', async () => {
    await mustFail(
      () => db.execute(sql`UPDATE users SET role = 'superuser' WHERE id = ${userId}`),
      CHECK,
      'role superuser',
    );
  });

  await check('one Google account cannot be linked to two users', async () => {
    const otherId = newId();
    userIds.push(otherId);
    await db
      .insert(users)
      .values({ id: otherId, email: `other-${String(stamp)}@example.test`, name: 'Other' });

    const subject = `google-subject-${String(stamp)}`;
    await db.insert(userIdentities).values({ provider: 'google', subject, userId });

    await mustFail(
      () => db.insert(userIdentities).values({ provider: 'google', subject, userId: otherId }),
      UNIQUE,
      'the same Google subject on a second account',
    );
  });

  /* ---------------- decks ---------------- */

  const deck = await deckService.createDeck(userId, {
    title: 'Verification Deck',
    slideKinds: ['multiple_choice', 'word_cloud'],
  });

  await check('a deck stores its slides with their config, in order', async () => {
    const [stored] = await db.select().from(decks).where(eq(decks.id, deck.id));
    assert(stored, 'deck not found');
    assert(stored.slides.length === 2, `expected 2 slides, found ${String(stored.slides.length)}`);
    assert(stored.slides[0]?.kind === 'multiple_choice', 'slide order was not kept');
    const defaults = SLIDE_REGISTRY.multiple_choice.defaults() as Record<string, unknown>;
    assert(
      sameContent(stored.slides[0].config.options, defaults.options),
      'slide config did not survive the round trip',
    );
  });

  await check('a deck applies its default theme and settings', () => {
    assert(sameContent(deck.theme, DEFAULT_THEME), 'theme default missing');
    assert(sameContent(deck.settings, DEFAULT_SETTINGS), 'settings default missing');
  });

  await check('an unknown slide kind is refused rather than crashing', async () => {
    try {
      await deckService.addSlide(deck.id, userId, { kind: 'not_a_real_kind' as SlideKind });
    } catch (err) {
      assert(err instanceof HttpError, `expected a clear refusal, got ${String(err)}`);
      assert(err.code === 'unknown_slide_kind', `wrong code: ${err.code}`);
      return;
    }
    throw new Error('an unknown slide kind was accepted');
  });

  await check('a deck whose slides are not a list is rejected', async () => {
    await mustFail(
      () =>
        db.execute(sql`UPDATE decks SET slides = '{"not": "a list"}'::jsonb WHERE id = ${deck.id}`),
      CHECK,
      'slides as an object',
    );
  });

  await check('a deck cannot belong to an account that does not exist', async () => {
    await mustFail(
      () => db.insert(decks).values({ id: newId(), ownerId: newId(), title: 'Orphan' }),
      FOREIGN_KEY,
      'a deck with no owner',
    );
  });

  /* ---------------- sessions ---------------- */

  const joinCode = String(100000 + (stamp % 900000));
  const snapshot = { title: deck.title, slides: deck.slides };

  const sessionId = newId();
  await db.insert(sessions).values({
    id: sessionId,
    deckId: deck.id,
    ownerId: userId,
    title: deck.title,
    joinCode,
    joinSlug: `verify${String(stamp)}`,
    mode: 'presenter_paced',
    deckSnapshot: snapshot,
    currentSlideId: deck.slides[0]?.id ?? null,
  });

  await check('a session freezes a copy of the deck', async () => {
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    assert(stored?.deckSnapshot.slides.length === 2, 'snapshot did not store the slides');
  });

  await check('editing the deck does not change the frozen snapshot', async () => {
    await deckService.updateDeck(deck.id, userId, { title: 'Renamed After Session' });
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    assert(stored?.deckSnapshot.title === 'Verification Deck', 'snapshot followed the deck edit');
  });

  await check('a second live session cannot reuse a join code', async () => {
    await mustFail(
      () =>
        db.insert(sessions).values({
          id: newId(),
          deckId: deck.id,
          ownerId: userId,
          title: 'Clash',
          joinCode,
          joinSlug: `clash${String(stamp)}`,
          mode: 'presenter_paced',
          deckSnapshot: snapshot,
        }),
      UNIQUE,
      'a duplicate live join code',
    );
  });

  await check('a closed session releases its join code for reuse', async () => {
    await db
      .update(sessions)
      .set({ state: 'closed', endedAt: new Date() })
      .where(eq(sessions.id, sessionId));

    const reuseId = newId();
    await db.insert(sessions).values({
      id: reuseId,
      deckId: deck.id,
      ownerId: userId,
      title: 'Reuse',
      joinCode,
      joinSlug: `reuse${String(stamp)}`,
      mode: 'presenter_paced',
      deckSnapshot: snapshot,
    });

    // Closed again straight away, so the rest of this run is not holding a
    // live code someone else might be dealt.
    await db.update(sessions).set({ state: 'closed' }).where(eq(sessions.id, reuseId));
  });

  await check('an invalid session state is rejected', async () => {
    await mustFail(
      () => db.execute(sql`UPDATE sessions SET state = 'exploded' WHERE id = ${sessionId}`),
      CHECK,
      'state exploded',
    );
  });

  /* ---------------- participants and answers ---------------- */

  const participantId = newId();
  await db.insert(participants).values({
    id: participantId,
    sessionId,
    deviceToken: `device-${String(stamp)}`,
    displayName: 'Tester',
  });

  await check('the same device cannot join a session twice', async () => {
    await mustFail(
      () =>
        db
          .insert(participants)
          .values({ id: newId(), sessionId, deviceToken: `device-${String(stamp)}` }),
      UNIQUE,
      'a second participant for one device',
    );
  });

  const answer = {
    sessionId,
    slideId: deck.slides[0]?.id ?? 'slide',
    participantId,
    kind: 'multiple_choice',
    payload: { optionIds: ['o1'] },
    clientMsgId: `msg-${String(stamp)}`,
  };

  await db.insert(responses).values({ id: newId(), ...answer });

  await check('a retried submission is counted exactly once', async () => {
    await mustFail(
      () => db.insert(responses).values({ id: newId(), ...answer }),
      UNIQUE,
      'a second answer with the same clientMsgId',
    );

    const rows = await db
      .select({ id: responses.id })
      .from(responses)
      .where(
        and(eq(responses.sessionId, sessionId), eq(responses.clientMsgId, answer.clientMsgId)),
      );
    assert(rows.length === 1, `expected 1 stored answer, found ${String(rows.length)}`);
  });

  await check('the application recognises a duplicate as a duplicate', async () => {
    try {
      await db.insert(responses).values({ id: newId(), ...answer });
    } catch (err) {
      // What recordAnswer and the question handler rely on to treat a retry
      // as success rather than a crash.
      assert(
        isUniqueViolation(err, 'responses_session_client_msg_key'),
        'isUniqueViolation missed it',
      );
      return;
    }
    throw new Error('the duplicate was accepted');
  });

  await check('a removed answer is hidden but not destroyed', async () => {
    await db
      .update(responses)
      .set({ deletedAt: new Date(), deletedReason: 'presenter' })
      .where(eq(responses.clientMsgId, answer.clientMsgId));

    const live = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.sessionId, sessionId), isNull(responses.deletedAt)));
    const all = await db
      .select({ id: responses.id })
      .from(responses)
      .where(eq(responses.sessionId, sessionId));

    assert(live.length === 0, 'a removed answer is still counted');
    assert(all.length === 1, 'the removed answer was destroyed');
  });

  await check('an answer cannot reference a participant who does not exist', async () => {
    await mustFail(
      () =>
        db.insert(responses).values({
          ...answer,
          id: newId(),
          participantId: newId(),
          clientMsgId: `orphan-${String(stamp)}`,
        }),
      FOREIGN_KEY,
      'an answer from nobody',
    );
  });

  await check('an audience question is recorded and defaults to approved', async () => {
    const [question] = await db
      .insert(audienceQuestions)
      .values({
        id: newId(),
        sessionId,
        participantId,
        body: 'Is this working?',
        clientMsgId: `q-${String(stamp)}`,
      })
      .returning();
    assert(question?.status === 'approved', `status defaulted to ${question?.status ?? 'nothing'}`);
    assert(question.upvotes === 0, 'upvotes did not default to 0');
  });

  /* ---------------- what happens on delete ---------------- */

  await check('purging a deck keeps its sessions, detached from it', async () => {
    // The history of having presented something is not the deck's to take.
    await db.delete(decks).where(eq(decks.id, deck.id));
    const [stored] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    assert(stored, 'deleting the deck deleted its session');
    assert(stored.deckId === null, 'the session still points at a deck that no longer exists');
  });

  await check('removing a participant removes their answers and questions with them', async () => {
    await db.delete(participants).where(eq(participants.id, participantId));
    const leftAnswers = await db
      .select()
      .from(responses)
      .where(eq(responses.participantId, participantId));
    const leftQuestions = await db
      .select()
      .from(audienceQuestions)
      .where(eq(audienceQuestions.participantId, participantId));
    assert(
      leftAnswers.length === 0 && leftQuestions.length === 0,
      'rows were left pointing at nobody',
    );
  });

  /* ---------------- races the database settles ---------------- */

  /*
   * Each of these used to be a check followed by a write, which two requests
   * arriving together can both pass. Each check fires its requests at the
   * same moment, because a race never shows up in a test that waits its turn.
   */

  /*
   * Opens connections before racing. A cold pool has to establish each new
   * connection before its query can run, which takes long enough that
   * "simultaneous" requests quietly run one after another -- and a race test
   * that cannot race passes whether or not the protection exists.
   */
  const warmPool = () =>
    Promise.all(Array.from({ length: 10 }, () => db.execute(sql`SELECT pg_sleep(0.05)`)));

  const raceDeck = await deckService.createDeck(userId, {
    title: 'Race deck',
    slideKinds: ['word_cloud'],
  });

  await check('pressing Present several times at once starts one session', async () => {
    await warmPool();
    const started = await Promise.all(
      Array.from({ length: 8 }, () => sessionService.startSession(raceDeck.id, userId)),
    );

    const distinct = new Set(started.map((session) => session.id));
    assert(distinct.size === 1, `${String(distinct.size)} sessions were started for one deck`);

    const live = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.deckId, raceDeck.id), eq(sessions.state, 'live')));
    assert(live.length === 1, `${String(live.length)} live sessions exist for one deck`);
  });

  await check('one phone sending several different answers at once keeps only one', async () => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.deckId, raceDeck.id), eq(sessions.state, 'live')));
    assert(session, 'no live session to answer');

    const phone = await sessionService.joinSession(session, `race-${String(stamp)}`, 'Racer', 'en');
    const slideId = session.deckSnapshot.slides[0]?.id ?? '';

    await warmPool();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        sessionService.recordAnswer({
          session,
          participant: phone,
          slideId,
          payload: { words: [`word${String(i)}`] },
          clientMsgId: `race-${String(stamp)}-${String(i)}`,
        }),
      ),
    );

    const stored = await db
      .select({ id: responses.id })
      .from(responses)
      .where(and(eq(responses.participantId, phone.id), eq(responses.slideId, slideId)));
    assert(stored.length === 1, `${String(stored.length)} answers were stored for one phone`);

    const refused = results.filter((r) => r.status === 'rejected');
    assert(refused.length === 7, `${String(refused.length)} of 7 extra answers were refused`);
    for (const r of refused) {
      const reason = r.reason as unknown;
      assert(
        reason instanceof HttpError && reason.code === 'already_answered',
        `an extra answer failed with ${String(reason)} rather than already_answered`,
      );
    }

    const [counted] = await db
      .select({ responseCount: sessions.responseCount })
      .from(sessions)
      .where(eq(sessions.id, session.id));
    assert(counted?.responseCount === 1, `the session counted ${String(counted?.responseCount)}`);
  });

  await check('the daily AI limit holds when requests arrive together', async () => {
    // One request left for today, then five at once.
    await db
      .update(users)
      .set({ aiRequestsToday: DAILY_AI_LIMIT - 1, aiRequestsResetAt: new Date() })
      .where(eq(users.id, userId));

    await warmPool();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => consumeQuota(userId)));

    const allowed = results.filter((r) => r.status === 'fulfilled').length;
    assert(allowed === 1, `${String(allowed)} requests got through with one left`);

    const [after] = await db
      .select({ used: users.aiRequestsToday })
      .from(users)
      .where(eq(users.id, userId));
    assert(after?.used === DAILY_AI_LIMIT, `the count went to ${String(after?.used)}`);
  });

  await check('the AI count starts again on a new day', async () => {
    // A count left over from yesterday must not block today's first request.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .update(users)
      .set({ aiRequestsToday: DAILY_AI_LIMIT, aiRequestsResetAt: yesterday })
      .where(eq(users.id, userId));

    const quota = await consumeQuota(userId);
    assert(quota.used === 1, `the first request of a new day counted as ${String(quota.used)}`);
  });

  /* ---------------- structure ---------------- */

  await check('every expected index exists on the server', async () => {
    const result = await db.execute<{ table: string; indexes: number }>(sql`
      SELECT tablename AS table, count(*)::int AS indexes
      FROM pg_indexes WHERE schemaname = 'public' GROUP BY tablename
    `);
    const found = new Map(result.rows.map((row) => [row.table, row.indexes]));

    // Primary key plus each declared index.
    const expectations: [string, number][] = [
      ['users', 4],
      ['user_identities', 2],
      ['refresh_tokens', 5],
      ['decks', 3],
      ['sessions', 6],
      ['participants', 3],
      ['responses', 6],
      ['audience_questions', 3],
    ];

    for (const [name, minimum] of expectations) {
      const count = found.get(name) ?? 0;
      assert(
        count >= minimum,
        `${name} has ${String(count)} indexes, expected at least ${String(minimum)}`,
      );
    }
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up test data...${X}\n`);

  // Deleting the users takes everything else with them through the cascades.
  for (const id of userIds) {
    await db.delete(users).where(eq(users.id, id));
  }

  const leftover = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (leftover.length > 0) throw new Error('cleanup did not remove the test user');

  process.stdout.write(
    `\n  ${passed > 0 ? G : D}${String(passed)} passed${X}` +
      (failed > 0 ? `   ${R}${B}${String(failed)} failed${X}` : '') +
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
