import { Types } from 'mongoose';
import { Deck, positionBetween, POSITION_GAP, type DeckDoc } from '../models/index.js';
import { HttpError } from '../app.js';
import { SLIDE_REGISTRY, definitionFor, type SlideKind, type SlideConfig } from '@pulse/shared';

/**
 * Deck reads and writes.
 *
 * Every function takes the owner's id and scopes its query by it. Ownership
 * is therefore enforced by the query itself rather than by a check the
 * caller has to remember: a deck belonging to someone else simply is not
 * found, which is also the right thing to tell the caller — confirming that
 * a deck exists but is not yours leaks information.
 */

/** A deck the caller is allowed to touch, or a 404. */
async function ownedDeck(deckId: string, ownerId: string): Promise<DeckDoc> {
  if (!Types.ObjectId.isValid(deckId)) {
    throw new HttpError(404, 'That deck was not found.', 'deck_not_found');
  }

  const deck = await Deck.findOne({ _id: deckId, ownerId, deletedAt: null });
  if (!deck) {
    throw new HttpError(404, 'That deck was not found.', 'deck_not_found');
  }
  return deck;
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

export async function listDecks(
  ownerId: string,
  options: { includeArchived?: boolean; search?: string } = {},
): Promise<DeckSummary[]> {
  const filter: Record<string, unknown> = { ownerId, deletedAt: null };
  if (!options.includeArchived) filter.archivedAt = null;

  const search = options.search?.trim();
  if (search) {
    // Escaped so a title containing regex characters cannot change the query.
    filter.title = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const decks = await Deck.find(filter)
    .select('title description slides theme archivedAt updatedAt createdAt')
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();

  return decks.map((deck) => ({
    id: deck._id.toString(),
    title: deck.title,
    description: deck.description,
    slideCount: deck.slides.length,
    preview: deck.slides.slice(0, 5).map((s) => s.kind),
    theme: {
      preset: deck.theme.preset,
      accent: deck.theme.accent,
      mode: deck.theme.mode,
    },
    archived: deck.archivedAt !== null,
    updatedAt: deck.updatedAt,
    createdAt: deck.createdAt,
  }));
}

export async function getDeck(deckId: string, ownerId: string): Promise<DeckDoc> {
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

export async function createDeck(ownerId: string, input: CreateDeckInput = {}): Promise<DeckDoc> {
  const kinds = input.slideKinds ?? [];

  return Deck.create({
    ownerId,
    title: titleOrDefault(input.title),
    description: input.description?.trim() ?? '',
    slides: kinds.map((kind, i) => ({
      id: newSlideId(),
      kind,
      position: (i + 1) * POSITION_GAP,
      config: SLIDE_REGISTRY[kind].defaults(),
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Update                                                             */
/* ------------------------------------------------------------------ */

export interface UpdateDeckInput {
  title?: string;
  description?: string;
  theme?: Partial<{
    preset: string;
    accent: string;
    background: string;
    fontFamily: string;
    logoUrl: string;
    mode: 'dark' | 'light';
  }>;
  settings?: Partial<{
    mode: 'presenter_paced' | 'audience_paced';
    collectNames: boolean;
    showResultsToParticipants: boolean;
    profanityFilter: boolean;
    reactions: boolean;
    chat: boolean;
    oneAnswerPerDevice: boolean;
  }>;
}

export async function updateDeck(
  deckId: string,
  ownerId: string,
  input: UpdateDeckInput,
): Promise<DeckDoc> {
  const deck = await ownedDeck(deckId, ownerId);

  if (input.title !== undefined) deck.title = titleOrDefault(input.title);
  if (input.description !== undefined) deck.description = input.description;
  if (input.theme) Object.assign(deck.theme, input.theme);
  if (input.settings && deck.settings) Object.assign(deck.settings, input.settings);

  deck.revision += 1;
  await deck.save();
  return deck;
}

export async function archiveDeck(
  deckId: string,
  ownerId: string,
  archived: boolean,
): Promise<DeckDoc> {
  const deck = await ownedDeck(deckId, ownerId);
  deck.archivedAt = archived ? new Date() : null;
  await deck.save();
  return deck;
}

/** Soft delete. The row stays for 30 days so an accidental delete is undoable. */
export async function deleteDeck(deckId: string, ownerId: string): Promise<void> {
  const deck = await ownedDeck(deckId, ownerId);
  deck.deletedAt = new Date();
  await deck.save();
}

export async function duplicateDeck(deckId: string, ownerId: string): Promise<DeckDoc> {
  const source = await ownedDeck(deckId, ownerId);

  return Deck.create({
    ownerId,
    title: `${source.title} (copy)`.slice(0, 200),
    description: source.description,
    // New slide ids: the copy must not share ids with the original, or
    // editing one would look like editing the other in any client cache.
    slides: source.slides.map((slide) => ({
      id: newSlideId(),
      kind: slide.kind,
      position: slide.position,
      config: structuredClone(slide.config) as SlideConfig,
    })),
    theme: { ...source.theme },
    settings: source.settings,
    tags: source.tags,
  });
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

/** Slide ids are generated server-side on insert and never reused. */
function newSlideId(): string {
  return new Types.ObjectId().toString();
}

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
): Promise<{ deck: DeckDoc; slideId: string }> {
  const deck = await ownedDeck(deckId, ownerId);

  if (deck.slides.length >= 200) {
    throw new HttpError(422, 'A deck can hold at most 200 slides.', 'deck_full');
  }

  const defaults = SLIDE_REGISTRY[input.kind].defaults();
  // A partial config from the client is merged over the defaults, so the
  // editor can create a slide with a prompt already filled in.
  const merged =
    input.config && typeof input.config === 'object'
      ? { ...defaults, ...input.config, kind: input.kind }
      : defaults;

  const config = validateConfig(input.kind, merged);

  const ordered = [...deck.slides].sort((a, b) => a.position - b.position);
  let position: number;

  if (input.afterSlideId) {
    const index = ordered.findIndex((s) => s.id === input.afterSlideId);
    if (index === -1) {
      throw new HttpError(404, 'That slide was not found.', 'slide_not_found');
    }
    const before = ordered[index]?.position ?? null;
    const after = ordered[index + 1]?.position ?? null;
    position = positionBetween(before, after);
  } else {
    position = positionBetween(ordered[ordered.length - 1]?.position ?? null, null);
  }

  const slideId = newSlideId();
  deck.slides.push({ id: slideId, kind: input.kind, position, config });
  deck.revision += 1;
  await deck.save();

  return { deck, slideId };
}

export async function updateSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
  config: unknown,
): Promise<DeckDoc> {
  const deck = await ownedDeck(deckId, ownerId);

  const slide = deck.slides.find((s) => s.id === slideId);
  if (!slide) {
    throw new HttpError(404, 'That slide was not found.', 'slide_not_found');
  }

  // Merged over the current config rather than replacing it, so a caller can
  // send only the fields it changed. A replace would mean every editor panel
  // had to round-trip the whole config, and two panels saving at once would
  // silently undo each other.
  //
  // The kind is immutable: changing it would invalidate answers already
  // collected against this slide. Switching type means adding a new slide.
  const incoming: object = config && typeof config === 'object' ? config : {};
  slide.config = validateConfig(slide.kind, {
    ...(slide.config as SlideConfig),
    ...incoming,
    kind: slide.kind,
  });

  deck.revision += 1;
  await deck.save();
  return deck;
}

export async function deleteSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
): Promise<DeckDoc> {
  const deck = await ownedDeck(deckId, ownerId);

  const index = deck.slides.findIndex((s) => s.id === slideId);
  if (index === -1) {
    throw new HttpError(404, 'That slide was not found.', 'slide_not_found');
  }
  // splice on the DocumentArray in place; reassigning a plain array would
  // discard the typed wrapper Mongoose needs to track the change.
  deck.slides.splice(index, 1);

  deck.revision += 1;
  await deck.save();
  return deck;
}

export async function duplicateSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
): Promise<{ deck: DeckDoc; slideId: string }> {
  const deck = await ownedDeck(deckId, ownerId);

  const ordered = [...deck.slides].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((s) => s.id === slideId);
  if (index === -1) {
    throw new HttpError(404, 'That slide was not found.', 'slide_not_found');
  }

  const source = ordered[index];
  if (!source) throw new HttpError(404, 'That slide was not found.', 'slide_not_found');

  if (deck.slides.length >= 200) {
    throw new HttpError(422, 'A deck can hold at most 200 slides.', 'deck_full');
  }

  const newId = newSlideId();
  deck.slides.push({
    id: newId,
    kind: source.kind,
    // Sits directly after the slide it was copied from.
    position: positionBetween(source.position, ordered[index + 1]?.position ?? null),
    config: structuredClone(source.config) as SlideConfig,
  });

  deck.revision += 1;
  await deck.save();
  return { deck, slideId: newId };
}

/**
 * Moves a slide between two others.
 *
 * Positions are fractional, so this writes one number instead of renumbering
 * the deck. Repeated halving eventually exhausts float precision, so when the
 * gap becomes too small the whole deck is renumbered — rare, and invisible.
 */
export async function moveSlide(
  deckId: string,
  ownerId: string,
  slideId: string,
  toIndex: number,
): Promise<DeckDoc> {
  const deck = await ownedDeck(deckId, ownerId);

  const ordered = [...deck.slides].sort((a, b) => a.position - b.position);
  const from = ordered.findIndex((s) => s.id === slideId);
  if (from === -1) {
    throw new HttpError(404, 'That slide was not found.', 'slide_not_found');
  }

  const clamped = Math.max(0, Math.min(toIndex, ordered.length - 1));
  if (clamped === from) return deck;

  const [moved] = ordered.splice(from, 1);
  if (!moved) return deck;
  ordered.splice(clamped, 0, moved);

  const before = ordered[clamped - 1]?.position ?? null;
  const after = ordered[clamped + 1]?.position ?? null;
  const next = positionBetween(before, after);

  const target = deck.slides.find((s) => s.id === slideId);
  if (!target) return deck;

  // Below roughly 0.0001 apart, further halving starts losing precision.
  const tooTight =
    (before !== null && Math.abs(next - before) < 1e-4) ||
    (after !== null && Math.abs(after - next) < 1e-4);

  if (tooTight) {
    ordered.forEach((slide, i) => {
      const doc = deck.slides.find((s) => s.id === slide.id);
      if (doc) doc.position = (i + 1) * POSITION_GAP;
    });
  } else {
    target.position = next;
  }

  deck.revision += 1;
  await deck.save();
  return deck;
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
  theme: DeckDoc['theme'];
  /** Absent on very old rows written before settings had defaults. */
  settings: DeckDoc['settings'];
  revision: number;
  archived: boolean;
  updatedAt: Date;
  createdAt: Date;
}

/** Slides always leave the server in display order. */
export function toPublicDeck(deck: DeckDoc): PublicDeck {
  return {
    id: deck._id.toString(),
    title: deck.title,
    description: deck.description,
    // Sorted on a copy so the document's own array order is untouched.
    // The annotation is needed because slides[].config is Schema.Types.Mixed,
    // which Mongoose types as `any`; it is validated on the way in by the
    // kind's own Zod schema, so the shape is known here even though the
    // type system cannot see it.
    slides: (
      deck.slides.slice() as {
        id: string;
        kind: SlideKind;
        position: number;
        config: SlideConfig;
      }[]
    )
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        position: s.position,
        config: s.config,
      })),
    theme: { ...deck.theme },
    settings: deck.settings,
    revision: deck.revision,
    archived: deck.archivedAt !== null,
    updatedAt: deck.updatedAt,
    createdAt: deck.createdAt,
  };
}
