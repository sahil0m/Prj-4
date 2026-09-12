/**
 * Deck service checks, run against the real database.
 *
 * These cover the things unit tests with a mocked model cannot: that
 * ownership scoping really excludes other people's rows, that fractional
 * positions survive repeated inserts, and that Mongoose persists what we
 * think it does.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { Deck, User } from '../models/index.js';
import { HttpError } from '../app.js';
import * as decks from '../services/decks.js';
import type { SlideKind } from '@pulse/shared';

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

/** Asserts the call fails with a specific error code. */
async function expectFailure(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError && err.code === code) return;
    throw new Error(`expected ${code}, got ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** The slide order as an array of ids, read back from the database. */
async function orderOf(deckId: string, ownerId: string): Promise<string[]> {
  const deck = await decks.getDeck(deckId, ownerId);
  return decks.toPublicDeck(deck).slides.map((s) => s.id);
}

async function main(): Promise<void> {
  await connectDb();

  const stamp = Date.now();
  process.stdout.write(`\n${D}Deck service checks${X}\n\n`);

  const owner = await User.create({
    email: `deck-owner-${stamp}@example.test`,
    name: 'Deck Owner',
    passwordHash: 'x'.repeat(20),
  });
  const stranger = await User.create({
    email: `deck-stranger-${stamp}@example.test`,
    name: 'Stranger',
    passwordHash: 'x'.repeat(20),
  });

  const ownerId = owner._id.toString();
  const strangerId = stranger._id.toString();

  /* ---------------- create and list ---------------- */

  let deckId = '';

  await check('a new deck starts empty with a default title', async () => {
    const deck = await decks.createDeck(ownerId, {});
    deckId = deck._id.toString();
    assert(deck.title === 'Untitled deck', `title was ${deck.title}`);
    assert(deck.slides.length === 0, 'new deck should have no slides');
    assert(deck.revision === 1, 'revision should start at 1');
  });

  await check('a deck can be seeded with slide kinds in order', async () => {
    const kinds: SlideKind[] = ['word_cloud', 'multiple_choice', 'heading'];
    const deck = await decks.createDeck(ownerId, { title: 'Seeded', slideKinds: kinds });
    const public_ = decks.toPublicDeck(deck);
    assert(public_.slides.length === 3, 'expected 3 slides');
    assert(
      public_.slides.map((s) => s.kind).join(',') === kinds.join(','),
      'slides came back in the wrong order',
    );
  });

  await check('seeded slides carry their kind defaults', async () => {
    const deck = await decks.createDeck(ownerId, { slideKinds: ['word_cloud'] });
    const slide = decks.toPublicDeck(deck).slides[0];
    assert(slide, 'slide missing');
    const config = slide.config as { prompt: string; maxCharacters: number };
    assert(config.prompt.length > 0, 'default prompt should not be blank');
    assert(config.maxCharacters === 30, 'default maxCharacters should be 30');
  });

  await check('the listing returns the owner decks, newest first', async () => {
    const list = await decks.listDecks(ownerId);
    assert(list.length >= 3, `expected at least 3 decks, got ${list.length}`);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      assert(prev && cur, 'listing gap');
      assert(
        prev.updatedAt.getTime() >= cur.updatedAt.getTime(),
        'listing is not sorted newest first',
      );
    }
  });

  await check('the listing never shows another user deck', async () => {
    const list = await decks.listDecks(strangerId);
    assert(list.length === 0, `stranger saw ${list.length} decks`);
  });

  await check('search matches titles case-insensitively', async () => {
    const list = await decks.listDecks(ownerId, { search: 'seed' });
    assert(list.length === 1, `expected 1 result, got ${list.length}`);
    assert(list[0]?.title === 'Seeded', 'wrong deck matched');
  });

  await check('a regex character in search is treated literally', async () => {
    // Unescaped, ".*" would match every deck the user owns.
    const list = await decks.listDecks(ownerId, { search: '.*' });
    assert(list.length === 0, `".*" matched ${list.length} decks; it should match none`);
  });

  /* ---------------- ownership ---------------- */

  await check('a stranger cannot read the deck', async () => {
    await expectFailure(() => decks.getDeck(deckId, strangerId), 'deck_not_found');
  });

  await check('a stranger cannot edit the deck', async () => {
    await expectFailure(
      () => decks.updateDeck(deckId, strangerId, { title: 'Stolen' }),
      'deck_not_found',
    );
  });

  await check('a stranger cannot delete the deck', async () => {
    await expectFailure(() => decks.deleteDeck(deckId, strangerId), 'deck_not_found');
  });

  await check('a malformed deck id is a not-found, not a crash', async () => {
    await expectFailure(() => decks.getDeck('not-an-object-id', ownerId), 'deck_not_found');
  });

  /* ---------------- slides ---------------- */

  await check('adding a slide appends it to the end', async () => {
    await decks.addSlide(deckId, ownerId, { kind: 'word_cloud' });
    await decks.addSlide(deckId, ownerId, { kind: 'multiple_choice' });
    const deck = await decks.getDeck(deckId, ownerId);
    const kinds = decks.toPublicDeck(deck).slides.map((s) => s.kind);
    assert(kinds.join(',') === 'word_cloud,multiple_choice', `order was ${kinds.join(',')}`);
  });

  await check('a slide can be inserted between two others', async () => {
    const order = await orderOf(deckId, ownerId);
    const first = order[0];
    assert(first, 'setup failed');

    const { slideId } = await decks.addSlide(deckId, ownerId, {
      kind: 'heading',
      afterSlideId: first,
    });

    const after = await orderOf(deckId, ownerId);
    assert(after[1] === slideId, `inserted slide landed at index ${after.indexOf(slideId)}`);
    assert(after.length === 3, 'expected 3 slides');
  });

  await check('a partial config is merged over the defaults', async () => {
    const { slideId } = await decks.addSlide(deckId, ownerId, {
      kind: 'word_cloud',
      config: { prompt: 'Custom prompt' },
    });
    const deck = await decks.getDeck(deckId, ownerId);
    const slide = decks.toPublicDeck(deck).slides.find((s) => s.id === slideId);
    const config = slide?.config as { prompt: string; maxCharacters: number };
    assert(config.prompt === 'Custom prompt', 'the override was lost');
    assert(config.maxCharacters === 30, 'the defaults were lost');
  });

  await check('an invalid config is refused', async () => {
    await expectFailure(
      () =>
        decks.addSlide(deckId, ownerId, {
          kind: 'word_cloud',
          config: { maxCharacters: -5 },
        }),
      'invalid_slide_config',
    );
  });

  // Zod strips unknown keys, so this must name the real field. An earlier
  // version of this test used "url" instead of "imageUrl" and passed while
  // testing nothing at all.
  await check('a javascript: url in a config is refused', async () => {
    await expectFailure(
      () =>
        decks.addSlide(deckId, ownerId, {
          kind: 'image',
          config: { imageUrl: 'javascript:alert(1)' },
        }),
      'invalid_slide_config',
    );
  });

  await check('every dangerous url scheme is refused on an image slide', async () => {
    const schemes = [
      'javascript:alert(1)',
      'data:text/html,<script></script>',
      'vbscript:msgbox',
      'file:///etc/passwd',
    ];
    for (const imageUrl of schemes) {
      await expectFailure(
        () => decks.addSlide(deckId, ownerId, { kind: 'image', config: { imageUrl } }),
        'invalid_slide_config',
      );
    }
  });

  await check('an ordinary https image url is accepted', async () => {
    const { slideId } = await decks.addSlide(deckId, ownerId, {
      kind: 'image',
      config: { imageUrl: 'https://example.com/photo.png' },
    });
    const deck = await decks.getDeck(deckId, ownerId);
    const slide = decks.toPublicDeck(deck).slides.find((s) => s.id === slideId);
    assert(
      (slide?.config as { imageUrl: string }).imageUrl === 'https://example.com/photo.png',
      'a valid image url was not stored',
    );
    await decks.deleteSlide(deckId, ownerId, slideId);
  });

  await check('editing a slide keeps its kind', async () => {
    const order = await orderOf(deckId, ownerId);
    const id = order[0];
    assert(id, 'setup failed');

    await decks.updateSlide(deckId, ownerId, id, { prompt: 'Edited', kind: 'multiple_choice' });

    const deck = await decks.getDeck(deckId, ownerId);
    const slide = decks.toPublicDeck(deck).slides.find((s) => s.id === id);
    assert(slide?.kind === 'word_cloud', `kind changed to ${String(slide?.kind)}`);
    assert((slide.config as { prompt: string }).prompt === 'Edited', 'the edit was lost');
  });

  // A partial PUT must not destroy the fields it does not mention. The first
  // version of updateSlide replaced the whole config, so sending {prompt}
  // to a quiz slide wiped its options and then failed validation.
  await check('a partial edit keeps the fields it did not mention', async () => {
    const fresh = await decks.createDeck(ownerId, { slideKinds: ['quiz_select'] });
    const id = fresh._id.toString();
    const slide = decks.toPublicDeck(fresh).slides[0];
    assert(slide, 'setup failed');

    const optionsBefore = (slide.config as { options: unknown[] }).options.length;

    await decks.updateSlide(id, ownerId, slide.id, { prompt: 'What is 2 + 2?' });

    const after = decks.toPublicDeck(await decks.getDeck(id, ownerId)).slides[0];
    const config = after?.config as {
      prompt: string;
      options: unknown[];
      countdownSeconds: number;
    };
    assert(config.prompt === 'What is 2 + 2?', 'the edit did not save');
    assert(config.options.length === optionsBefore, 'the options were wiped by a partial edit');
    assert(config.countdownSeconds === 20, 'an untouched field was lost');
  });

  await check('an edit can still replace a list outright', async () => {
    const fresh = await decks.createDeck(ownerId, { slideKinds: ['multiple_choice'] });
    const id = fresh._id.toString();
    const slide = decks.toPublicDeck(fresh).slides[0];
    assert(slide, 'setup failed');

    await decks.updateSlide(id, ownerId, slide.id, {
      options: [
        { id: 'a', label: 'Tea' },
        { id: 'b', label: 'Coffee' },
      ],
    });

    const after = decks.toPublicDeck(await decks.getDeck(id, ownerId)).slides[0];
    const options = (after?.config as { options: { label: string }[] }).options;
    assert(options.length === 2, `expected 2 options, got ${options.length}`);
    assert(options[0]?.label === 'Tea', 'the replacement list did not take');
  });

  await check('a partial edit cannot smuggle in an invalid value', async () => {
    const fresh = await decks.createDeck(ownerId, { slideKinds: ['word_cloud'] });
    const id = fresh._id.toString();
    const slide = decks.toPublicDeck(fresh).slides[0];
    assert(slide, 'setup failed');

    await expectFailure(
      () => decks.updateSlide(id, ownerId, slide.id, { maxCharacters: 99999 }),
      'invalid_slide_config',
    );
  });

  await check('a duplicated slide sits directly after the original', async () => {
    const order = await orderOf(deckId, ownerId);
    const source = order[0];
    assert(source, 'setup failed');

    const { slideId } = await decks.duplicateSlide(deckId, ownerId, source);
    const after = await orderOf(deckId, ownerId);
    assert(after[1] === slideId, 'the copy did not land next to its original');
    assert(slideId !== source, 'the copy reused the original id');
  });

  await check('deleting a slide removes only that slide', async () => {
    const before = await orderOf(deckId, ownerId);
    const victim = before[1];
    assert(victim, 'setup failed');

    await decks.deleteSlide(deckId, ownerId, victim);

    const after = await orderOf(deckId, ownerId);
    assert(after.length === before.length - 1, 'wrong number of slides left');
    assert(!after.includes(victim), 'the slide is still there');
  });

  await check('an unknown slide id is a not-found', async () => {
    await expectFailure(
      () => decks.updateSlide(deckId, ownerId, 'nope', { prompt: 'x' }),
      'slide_not_found',
    );
  });

  /* ---------------- reordering ---------------- */

  await check('a slide can be moved to the front', async () => {
    const before = await orderOf(deckId, ownerId);
    const last = before[before.length - 1];
    assert(last, 'setup failed');

    await decks.moveSlide(deckId, ownerId, last, 0);

    const after = await orderOf(deckId, ownerId);
    assert(after[0] === last, 'the slide did not move to the front');
    assert(after.length === before.length, 'a slide was lost in the move');
  });

  await check('a slide can be moved to the end', async () => {
    const before = await orderOf(deckId, ownerId);
    const first = before[0];
    assert(first, 'setup failed');

    await decks.moveSlide(deckId, ownerId, first, before.length - 1);

    const after = await orderOf(deckId, ownerId);
    assert(after[after.length - 1] === first, 'the slide did not move to the end');
  });

  await check('moving a slide onto itself changes nothing', async () => {
    const before = await orderOf(deckId, ownerId);
    const id = before[1];
    assert(id, 'setup failed');

    await decks.moveSlide(deckId, ownerId, id, 1);

    const after = await orderOf(deckId, ownerId);
    assert(after.join(',') === before.join(','), 'the order changed');
  });

  await check('an out-of-range index is clamped rather than rejected', async () => {
    const before = await orderOf(deckId, ownerId);
    const first = before[0];
    assert(first, 'setup failed');

    await decks.moveSlide(deckId, ownerId, first, 999);

    const after = await orderOf(deckId, ownerId);
    assert(after[after.length - 1] === first, 'clamping did not put it last');
    assert(after.length === before.length, 'a slide was lost');
  });

  await check('repeated inserts at the same spot keep a correct order', async () => {
    // Fractional positioning halves the gap each time. This is the case that
    // eventually exhausts float precision, so the service renumbers.
    const fresh = await decks.createDeck(ownerId, { slideKinds: ['heading', 'heading'] });
    const id = fresh._id.toString();

    const start = await orderOf(id, ownerId);
    const anchor = start[0];
    assert(anchor, 'setup failed');

    const inserted: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const { slideId } = await decks.addSlide(id, ownerId, {
        kind: 'heading',
        afterSlideId: anchor,
      });
      inserted.push(slideId);
    }

    const order = await orderOf(id, ownerId);
    assert(order.length === 42, `expected 42 slides, got ${order.length}`);
    assert(order[0] === anchor, 'the anchor moved');

    // Each insert went directly after the anchor, so the most recent is
    // nearest to it and the order of insertions is reversed.
    const expected = [anchor, ...[...inserted].reverse()];
    assert(
      order.slice(0, expected.length).join(',') === expected.join(','),
      'repeated inserts produced the wrong order',
    );

    const positions = decks
      .toPublicDeck(await decks.getDeck(id, ownerId))
      .slides.map((s) => s.position);
    for (let i = 1; i < positions.length; i += 1) {
      const prev = positions[i - 1];
      const cur = positions[i];
      assert(prev !== undefined && cur !== undefined && cur > prev, 'positions are not increasing');
    }
  });

  /* ---------------- duplicate and archive ---------------- */

  await check('duplicating a deck copies slides with fresh ids', async () => {
    const source = await decks.getDeck(deckId, ownerId);
    const sourceIds = decks.toPublicDeck(source).slides.map((s) => s.id);

    const copy = await decks.duplicateDeck(deckId, ownerId);
    const copyPublic = decks.toPublicDeck(copy);

    assert(copyPublic.title === `${source.title} (copy)`, 'the copy title is wrong');
    assert(copyPublic.slides.length === sourceIds.length, 'slide count differs');
    for (const slide of copyPublic.slides) {
      assert(!sourceIds.includes(slide.id), 'the copy reused a slide id');
    }
  });

  await check('editing a copy does not change the original', async () => {
    const copy = await decks.duplicateDeck(deckId, ownerId);
    const copyId = copy._id.toString();
    const slide = decks.toPublicDeck(copy).slides[0];
    assert(slide, 'setup failed');

    await decks.updateSlide(copyId, ownerId, slide.id, { prompt: 'Changed in the copy' });

    const original = decks.toPublicDeck(await decks.getDeck(deckId, ownerId));
    const originalPrompt = (original.slides[0]?.config as { prompt?: string }).prompt;
    assert(originalPrompt !== 'Changed in the copy', 'editing the copy changed the original');
  });

  await check('an archived deck leaves the default listing', async () => {
    const target = await decks.createDeck(ownerId, { title: `Archive me ${stamp}` });
    const id = target._id.toString();

    await decks.archiveDeck(id, ownerId, true);

    const visible = await decks.listDecks(ownerId);
    assert(!visible.some((d) => d.id === id), 'the archived deck is still listed');

    const all = await decks.listDecks(ownerId, { includeArchived: true });
    assert(
      all.some((d) => d.id === id),
      'includeArchived did not bring it back',
    );
  });

  await check('a deleted deck disappears but is not destroyed', async () => {
    const target = await decks.createDeck(ownerId, { title: 'Delete me' });
    const id = target._id.toString();

    await decks.deleteDeck(id, ownerId);

    const list = await decks.listDecks(ownerId, { includeArchived: true });
    assert(!list.some((d) => d.id === id), 'the deleted deck is still listed');

    await expectFailure(() => decks.getDeck(id, ownerId), 'deck_not_found');

    const raw = await Deck.findById(id).lean();
    assert(raw !== null, 'the row was hard-deleted');
    assert(raw.deletedAt !== null, 'deletedAt was not set');
  });

  /* ---------------- limits ---------------- */

  await check('the revision counter rises with every change', async () => {
    const before = (await decks.getDeck(deckId, ownerId)).revision;
    await decks.updateDeck(deckId, ownerId, { title: 'Revised' });
    const after = (await decks.getDeck(deckId, ownerId)).revision;
    assert(after > before, `revision did not rise: ${before} then ${after}`);
  });

  await check('a blank title falls back rather than saving empty', async () => {
    await decks.updateDeck(deckId, ownerId, { title: '   ' });
    const deck = await decks.getDeck(deckId, ownerId);
    assert(deck.title === 'Untitled deck', `title became "${deck.title}"`);
  });

  /* ---------------- cleanup ---------------- */

  process.stdout.write(`\n${D}Cleaning up...${X}\n`);
  await Deck.deleteMany({ ownerId: { $in: [owner._id, stranger._id] } });
  await User.deleteMany({ _id: { $in: [owner._id, stranger._id] } });

  const summary =
    failed === 0 ? `${G}${passed} passed${X}` : `${R}${failed} failed${X}, ${passed} passed`;
  process.stdout.write(`\n  ${summary}\n\n`);

  await disconnectDb();
  if (failed > 0) process.exitCode = 1;
}

void main().catch((err: unknown) => {
  process.stdout.write(`${R}The run itself failed: ${String(err)}${X}\n`);
  process.exitCode = 1;
});
