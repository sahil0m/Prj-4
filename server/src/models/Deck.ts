import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';
import { SLIDE_KINDS } from '@pulse/shared';

/**
 * A deck is a template. Running it creates a Session, and the Session keeps
 * a frozen copy of the deck, so editing a deck never changes past results.
 *
 * Slides are embedded rather than stored in their own collection: a deck is
 * always read and written whole, and embedding means one round trip instead
 * of a join. The 16MB document limit is far beyond any realistic deck.
 */

const slideSchema = new Schema(
  {
    /** Stable id, generated client-side so drag-reorder needs no round trip. */
    id: { type: String, required: true, maxlength: 64 },

    kind: { type: String, required: true, enum: SLIDE_KINDS },

    /**
     * Fractional position. Slides sit at 1000, 2000, 3000 so one can be
     * inserted at 1500 without renumbering the rest. Reordering one slide
     * writes one number, not the whole array.
     */
    position: { type: Number, required: true },

    /**
     * The kind-specific settings, validated in the route by the Zod schema
     * from the slide registry. Mongoose stores it as an opaque object.
     */
    config: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const themeSchema = new Schema(
  {
    preset: { type: String, default: 'midnight', maxlength: 40 },
    accent: { type: String, default: '#6366f1', maxlength: 16 },
    background: { type: String, default: '', maxlength: 16 },
    fontFamily: { type: String, default: '', maxlength: 120 },
    logoUrl: { type: String, default: '', maxlength: 2000 },
    mode: { type: String, enum: ['dark', 'light'], default: 'dark' },
  },
  { _id: false },
);

const deckSchema = new Schema(
  {
    ownerId: { type: Types.ObjectId, ref: 'User', required: true, index: true },

    /** Set when the deck belongs to an organisation rather than a person. */
    organizationId: { type: Types.ObjectId, ref: 'Organization', default: null, index: true },

    folderId: { type: Types.ObjectId, ref: 'Folder', default: null, index: true },

    title: { type: String, required: true, trim: true, maxlength: 200, default: 'Untitled' },

    description: { type: String, default: '', maxlength: 1000 },

    slides: { type: [slideSchema], default: [] },

    theme: { type: themeSchema, default: () => ({}) },

    settings: {
      /** presenter_paced: everyone follows the presenter. audience_paced: self-serve. */
      mode: {
        type: String,
        enum: ['presenter_paced', 'audience_paced'],
        default: 'presenter_paced',
      },
      /** Ask participants for a name when they join. */
      collectNames: { type: Boolean, default: false },
      /** Let participants see results on their own phone after answering. */
      showResultsToParticipants: { type: Boolean, default: false },
      /** Block rude words before they reach the projector. */
      profanityFilter: { type: Boolean, default: true },
      /** Let the audience send emoji reactions. */
      reactions: { type: Boolean, default: true },
      /** Let the audience chat. */
      chat: { type: Boolean, default: false },
      /** One answer per device unless the slide says otherwise. */
      oneAnswerPerDevice: { type: Boolean, default: true },
    },

    tags: { type: [String], default: [] },

    /** Version counter, bumped on every save. Used for conflict detection. */
    revision: { type: Number, default: 1 },

    archivedAt: { type: Date, default: null },
    /** Soft delete; a job purges rows older than 30 days. */
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Dashboard listing: a user's decks, newest first, excluding deleted ones.
deckSchema.index({ ownerId: 1, deletedAt: 1, updatedAt: -1 });
// Search by title within an owner's decks.
deckSchema.index({ ownerId: 1, title: 'text' });

export type DeckDoc = HydratedDocument<InferSchemaType<typeof deckSchema>>;
export type SlideDoc = InferSchemaType<typeof slideSchema>;

export const Deck = model('Deck', deckSchema);

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
