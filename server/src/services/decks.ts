import { and, desc, eq, ilike, isNull } from 'drizzle-orm';
import { db, type Transaction } from '../lib/db.js';
import { newId, isId } from '../db/ids.js';
import {
  decks,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  type Deck,
  type DeckSettings,
  type DeckTheme,
  type StoredSlide,
} from '../db/schema.js';
import { HttpError } from '../app.js';
import {
  SLIDE_KINDS,
  SLIDE_REGISTRY,
  definitionFor,
  type SlideKind,
  type SlideConfig,
} from '@pulse/shared';

/**
 * Deck reads and writes.
 *
 * Every function takes the owner's id and scopes its query by it. Ownership
 * is therefore enforced by the query itself rather than by a check the
 * caller has to remember: a deck belonging to someone else simply is not
 * found, which is also the right thing to tell the caller -- confirming that
 * a deck exists but is not yours leaks information.
 */

/** Gap used when appending a slide to the end of a deck. */
export const POSITION_GAP = 1000;

/**
 * Returns the position for a slide inserted between two others.
 * Passing null for either side means "at the very start" or "at the very end".
 */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null) {
    return after === null ? POSITION_GAP : after - POSITION_GAP;
  }
  if (after === null) return before + POSITION_GAP;
  return (before + after) / 2;
}

const notFound = () => new HttpError(404, 'That deck was not found.', 'deck_not_found');

/** A deck the caller is allowed to read, or a 404. */
async function ownedDeck(deckId: string, ownerId: string): Promise<Deck> {
  if (!isId(deckId) || !isId(ownerId)) throw notFound();

  const [deck] = await db
    .select()
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId), isNull(decks.deletedAt)));

  if (!deck) throw notFound();
  return deck;
}

/**
 * Changes a deck under a row lock.
 *
 * Every edit reads the deck, changes it in memory and writes it back. Done
 * naively, two editor panels saving at the same moment both read the same
 * version and the second write silently undoes the first -- MongoDB's
 * save() had exactly that behaviour for the slides array. Locking the row
 * for the length of the change makes concurrent edits apply one after the
 * other instead.
 *
 * The callback returns the columns to write; the revision is bumped here
 * so no caller can forget it.
 */
async function mutateDeck<T>(
  deckId: string,
  ownerId: string,
  change: (
    deck: Deck,
    tx: Transaction,
  ) => Promise<{ values: Partial<Deck>; result: T; bump?: boolean }>,
): Promise<{ deck: Deck; result: T }> {
  if (!isId(deckId) || !isId(ownerId)) throw notFound();

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(decks)
      .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId), isNull(decks.deletedAt)))
      .for('update');

    if (!current) throw notFound();

    const { values, result, bump = true } = await change(current, tx);

    // A change that turned out to change nothing -- a slide dropped back
    // where it started -- writes nothing and bumps nothing.
    if (!bump && Object.keys(values).length === 0) return { deck: current, result };

    const [updated] = await tx
      .update(decks)
      .set({ ...values, ...(bump ? { revision: current.revision + 1 } : {}) })
      .where(eq(decks.id, deckId))
      .returning();

    if (!updated) throw notFound();
    return { deck: updated, result };
  });
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export interface DeckSummary {
  id: string;
  title: string;
  description: string;
  slideCount: number;
  /** The first few slide kinds, so the dashboard card can show icons. */
  preview: SlideKind[];
  theme: { preset: string; accent: string; mode: 'dark' | 'light' };
  archived: boolean;
  updatedAt: Date;
  createdAt: Date;
}

/** Escapes LIKE's wildcards, so a search for "50%" means those characters. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function listDecks(
  ownerId: string,
  options: { includeArchived?: boolean; search?: string } = {},
): Promise<DeckSummary[]> {
  if (!isId(ownerId)) return [];

  const conditions = [eq(decks.ownerId, ownerId), isNull(decks.deletedAt)];
  if (!options.includeArchived) conditions.push(isNull(decks.archivedAt));

  const search = options.search?.trim();
  if (search) conditions.push(ilike(decks.title, `%${likeLiteral(search)}%`));

  const rows = await db
    .select({
      id: decks.id,
      title: decks.title,
      description: decks.description,
      slides: decks.slides,
      theme: decks.theme,
      archivedAt: decks.archivedAt,
      updatedAt: decks.updatedAt,
      createdAt: decks.createdAt,
    })
    .from(decks)
    .where(and(...conditions))
    .orderBy(desc(decks.updatedAt))
    .limit(200);

  return rows.map((deck) => {
    const ordered = orderedSlides(deck.slides);
    const theme = themeOf(deck.theme);

    return {
      id: deck.id,
      title: deck.title,
      description: deck.description,
      slideCount: ordered.length,
      preview: ordered.slice(0, 5).map((s) => s.kind as SlideKind),
      theme: { preset: theme.preset, accent: theme.accent, mode: theme.mode },
      archived: deck.archivedAt !== null,
      updatedAt: deck.updatedAt,
      createdAt: deck.createdAt,
    };
  });
}

export async function getDeck(deckId: string, ownerId: string): Promise<Deck> {
  return ownedDeck(deckId, ownerId);
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export interface CreateDeckInput {
  title?: string;
  description?: string;
  /** Seed the deck with these slide kinds, in order. */
  slideKinds?: SlideKind[];
}

export async function createDeck(ownerId: string, input: CreateDeckInput = {}): Promise<Deck> {
  const kinds = input.slideKinds ?? [];

  const [deck] = await db
    .insert(decks)
    .values({
      id: newId(),
      ownerId,
      title: titleOrDefault(input.title),
      description: input.description?.trim() ?? '',
      slides: kinds.map((kind, i) => ({
        id: newId(),
        kind,
        position: (i + 1) * POSITION_GAP,
        config: SLIDE_REGISTRY[kind].defaults(),
      })),
      theme: DEFAULT_THEME,
      settings: DEFAULT_SETTINGS,
    })
    .returning();

  if (!deck) throw new Error('Deck insert returned no row');
  return deck;
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

export interface UpdateDeckInput {
  title?: string;
  description?: string;
  theme?: Partial<DeckTheme>;
  settings?: Partial<DeckSettings>;
}

export async function updateDeck(
  deckId: string,
  ownerId: string,
  input: UpdateDeckInput,
): Promise<Deck> {
  const { deck } = await mutateDeck(deckId, ownerId, (current) =>
    Promise.resolve({
      values: {
        ...(input.title === undefined ? {} : { title: titleOrDefault(input.title) }),
        ...(input.description === undefined ? {} : { description: input.description }),
        // Merged, so changing the accent does not reset the font.
        ...(input.theme ? { theme: { ...themeOf(current.theme), ...input.theme } } : {}),
        ...(input.settings
          ? { settings: { ...settingsOf(current.settings), ...input.settings } }
          : {}),
      },
      result: null,
    }),
  );

  return deck;
}

export async function archiveDeck(
  deckId: string,
  ownerId: string,
  archived: boolean,
): Promise<Deck> {
  const { deck } = await mutateDeck(deckId, ownerId, () =>
    Promise.resolve({
      values: { archivedAt: archived ? new Date() : null },
      result: null,
      // Putting a deck away is not an edit to its content.
      bump: false,
    }),
  );

  return deck;
}

/** Soft delete. The row stays for 30 days so an accidental delete is undoable. */
export async function deleteDeck(deckId: string, ownerId: string): Promise<void> {
  await mutateDeck(deckId, ownerId, () =>
    Promise.resolve({ values: { deletedAt: new Date() }, result: null, bump: false }),
  );
}

export async function duplicateDeck(deckId: string, ownerId: string): Promise<Deck> {
  const source = await ownedDeck(deckId, ownerId);

  const [copy] = await db
    .insert(decks)
    .values({
      id: newId(),
      ownerId,
      title: `${source.title} (copy)`.slice(0, 200),
      description: source.description,
      // New slide ids: the copy must not share ids with the original, or
      // editing one would look like editing the other in any client cache.
      slides: orderedSlides(source.slides).map((slide) => ({
        id: newId(),
        kind: slide.kind,
        position: slide.position,
        config: structuredClone(slide.config),
      })),
      theme: themeOf(source.theme),
      settings: settingsOf(source.settings),
      tags: [...source.tags],
    })
    .returning();

  if (!copy) throw new Error('Deck insert returned no row');
  return copy;
}

/* ------------------------------------------------------------------ */
/* Slides                                                              */
/* ------------------------------------------------------------------ */

/**
 * Validates a config against the schema for its kind.
 *
 * The registry is the single source of truth: adding a slide kind adds its
 * validation here automatically, with nothing to remember to wire up.
 */
export function validateConfig(kind: SlideKind, config: unknown): SlideConfig {
  const definition = definitionFor(kind);
  const result = definition.configSchema.safeParse(config);

  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(
      422,
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'That slide is not valid.',
      'invalid_slide_config',
    );
  }
  return result.data as SlideConfig;
}

/** A blank or whitespace-only title falls back rather than saving empty. */
function titleOrDefault(title: string | undefined): string {
  const trimmed = title?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : 'Untitled deck';
}

const MAX_SLIDES = 200;

const slideNotFound = () => new HttpError(404, 'That slide was not found.', 'slide_not_found');

export interface AddSlideInput {
  kind: SlideKind;
  /** Insert after this slide id. Omitted means append to the end. */
  afterSlideId?: string;
  /** Overrides merged over the kind's defaults. */
  config?: unknown;
}

export async function addSlide(
  deckId: string,
  ownerId: string,
  input: AddSlideInput,
): Promise<{ deck: Deck; slideId: string }> {
  /*
   * Checked here as well as in the route. Slides are stored as JSON, so the
   * database cannot refuse an unknown kind the way MongoDB's schema enum did;
   * without this, anything calling the service directly -- the AI builder,
   * a script -- would fail with a TypeError from the registry lookup instead
   * of a clear refusal.
   */
  if (!(SLIDE_KINDS as readonly string[]).includes(input.kind)) {
    throw new HttpError(422, 'That is not a slide type Pulse knows.', 'unknown_slide_kind');
  }

  const defaults = SLIDE_REGISTRY[input.kind].defaults();
  // A partial config from the client is merged over the defaults, so the
  // editor can create a slide with a prompt already filled in.
  const merged =
    input.config && typeof input.config === 'object'
      ? { ...defaults, ...input.config, kind: input.kind }
      : defaults;

  // Validated before the lock is taken: a rejected config should not hold
  // up anyone else editing the same deck.
  const config = validateConfig(input.kind, merged);

  const { deck, result } = await mutateDeck(deckId, ownerId, (current) => {
    const ordered = orderedSlides(current.slides);

    if (ordered.length >= MAX_SLIDES) {
      throw new HttpError(422, 'A deck can hold at most 200 slides.', 'deck_full');
    }

    let position: number;

    if (input.afterSlideId) {
      const index = ordered.findIndex((s) => s.id === input.afterSlideId);
      if (index === -1) throw slideNotFound();
      position = positionBetween(
        ordered[index]?.position ?? null,
        ordered[index + 1]?.position ?? null,
      );
    } else {
      position = positionBetween(ordered[ordered.length - 1]?.position ?? null, null);
    }

    const slideId = newId();
    const slide: StoredSlide = {
      id: slideId,
      kind: input.kind,
      position,
      config,
    };

    return Promise.resolve({ values: { slides: [...ordered, slide] }, result: slideId });
  });

  return { deck, slideId: result };
}

export async function updateSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
  config: unknown,
): Promise<Deck> {
  const { deck } = await mutateDeck(deckId, ownerId, (current) => {
    const slides = orderedSlides(current.slides);
    const slide = slides.find((s) => s.id === slideId);
    if (!slide) throw slideNotFound();

    const kind = slide.kind as SlideKind;

    // Merged over the current config rather than replacing it, so a caller
    // can send only the fields it changed. A replace would mean every editor
    // panel had to round-trip the whole config, and two panels saving at once
    // would silently undo each other.
    //
    // The kind is immutable: changing it would invalidate answers already
    // collected against this slide. Switching type means adding a new slide.
    const incoming: object = config && typeof config === 'object' ? config : {};
    const next = validateConfig(kind, { ...slide.config, ...incoming, kind });

    return Promise.resolve({
      values: {
        slides: slides.map((s) => (s.id === slideId ? { ...s, config: next } : s)),
      },
      result: null,
    });
  });

  return deck;
}

export async function deleteSlide(deckId: string, ownerId: string, slideId: string): Promise<Deck> {
  const { deck } = await mutateDeck(deckId, ownerId, (current) => {
    const slides = orderedSlides(current.slides);
    if (!slides.some((s) => s.id === slideId)) throw slideNotFound();

    return Promise.resolve({
      values: { slides: slides.filter((s) => s.id !== slideId) },
      result: null,
    });
  });

  return deck;
}

export async function duplicateSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
): Promise<{ deck: Deck; slideId: string }> {
  const { deck, result } = await mutateDeck(deckId, ownerId, (current) => {
    const ordered = orderedSlides(current.slides);
    const index = ordered.findIndex((s) => s.id === slideId);
    const source = ordered[index];
    if (index === -1 || !source) throw slideNotFound();

    if (ordered.length >= MAX_SLIDES) {
      throw new HttpError(422, 'A deck can hold at most 200 slides.', 'deck_full');
    }

    const newSlideId = newId();

    const copy: StoredSlide = {
      id: newSlideId,
      kind: source.kind,
      // Sits directly after the slide it was copied from.
      position: positionBetween(source.position, ordered[index + 1]?.position ?? null),
      config: structuredClone(source.config),
    };

    return Promise.resolve({ values: { slides: [...ordered, copy] }, result: newSlideId });
  });

  return { deck, slideId: result };
}

/**
 * Moves a slide between two others.
 *
 * Positions are fractional, so this writes one number instead of renumbering
 * the deck. Repeated halving eventually exhausts float precision, so when the
 * gap becomes too small the whole deck is renumbered -- rare, and invisible.
 */
export async function moveSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
  toIndex: number,
): Promise<Deck> {
  const { deck } = await mutateDeck(deckId, ownerId, (current) => {
    const ordered = orderedSlides(current.slides);
    const from = ordered.findIndex((s) => s.id === slideId);
    if (from === -1) throw slideNotFound();

    const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1));

    // Nothing to write, and nothing to bump: the deck has not changed.
    if (clamped === from) {
      return Promise.resolve({ values: {}, result: null, bump: false });
    }

    const reordered = [...ordered];
    const [moved] = reordered.splice(from, 1);
    if (!moved) return Promise.resolve({ values: {}, result: null, bump: false });
    reordered.splice(clamped, 0, moved);

    const before = reordered[clamped - 1]?.position ?? null;
    const after = reordered[clamped + 1]?.position ?? null;
    const next = positionBetween(before, after);

    // Below roughly 0.0001 apart, further halving starts losing precision.
    const tooTight =
      (before !== null && Math.abs(next - before) < 1e-4) ||
      (after !== null && Math.abs(after - next) < 1e-4);

    const slides = tooTight
      ? reordered.map((slide, i) => ({ ...slide, position: (i + 1) * POSITION_GAP }))
      : reordered.map((slide) => (slide.id === slideId ? { ...slide, position: next } : slide));

    return Promise.resolve({ values: { slides }, result: null });
  });

  return deck;
}

/* ------------------------------------------------------------------ */
/* Reading JSONB safely                                                */
/* ------------------------------------------------------------------ */

/**
 * Slides in display order, whatever order they were stored in.
 *
 * Tolerates a missing or malformed column rather than throwing, because a
 * deck that fails to load entirely is worse than one that loads empty.
 */
export function orderedSlides(slides: StoredSlide[] | null | undefined): StoredSlide[] {
  if (!Array.isArray(slides)) return [];
  return [...slides].sort((a, b) => a.position - b.position);
}

/** A theme with every field present, whatever an old row stored. */
export function themeOf(theme: Partial<DeckTheme> | null | undefined): DeckTheme {
  return { ...DEFAULT_THEME, ...(theme ?? {}) };
}

/** Settings with every field present, whatever an old row stored. */
export function settingsOf(settings: Partial<DeckSettings> | null | undefined): DeckSettings {
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export interface PublicSlide {
  id: string;
  kind: SlideKind;
  position: number;
  config: SlideConfig;
}

export interface PublicDeck {
  id: string;
  title: string;
  description: string;
  slides: PublicSlide[];
  theme: DeckTheme;
  settings: DeckSettings;
  revision: number;
  archived: boolean;
  updatedAt: Date;
  createdAt: Date;
}

/** Slides always leave the server in display order. */
export function toPublicDeck(deck: Deck): PublicDeck {
  return {
    id: deck.id,
    title: deck.title,
    description: deck.description,
    // Each config was validated by its kind's Zod schema on the way in.
    slides: orderedSlides(deck.slides).map((s) => ({
      id: s.id,
      kind: s.kind as SlideKind,
      position: s.position,
      config: s.config as SlideConfig,
    })),
    theme: themeOf(deck.theme),
    settings: settingsOf(deck.settings),
    revision: deck.revision,
    archived: deck.archivedAt !== null,
    updatedAt: deck.updatedAt,
    createdAt: deck.createdAt,
  };
}
