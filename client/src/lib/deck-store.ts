import { create } from 'zustand';
import { api, ApiError, type Deck, type Slide } from './api';
import type { SlideKind } from '@pulse/shared';

/**
 * The open deck.
 *
 * Edits apply locally first and then persist. An editor that waits for a
 * round trip before showing a typed character feels broken, and on a slow
 * connection it drops keystrokes. If a save fails, the deck is reloaded from
 * the server so the screen never keeps a change the database rejected.
 */

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface DeckState {
  deck: Deck | null;
  selectedSlideId: string | null;
  loading: boolean;
  loadError: string | null;
  saveState: SaveState;
  saveError: string | null;

  load: (deckId: string) => Promise<void>;
  close: () => void;
  select: (slideId: string) => void;

  rename: (title: string) => void;
  addSlide: (kind: SlideKind, afterSlideId?: string) => Promise<void>;
  updateSlideConfig: (slideId: string, patch: Record<string, unknown>) => void;
  deleteSlide: (slideId: string) => Promise<void>;
  duplicateSlide: (slideId: string) => Promise<void>;
  moveSlide: (slideId: string, toIndex: number) => Promise<void>;
}

/** The slide to select once another one is removed. */
function neighbourOf(slides: Slide[], removedId: string): string | null {
  const index = slides.findIndex((s) => s.id === removedId);
  if (index === -1) return slides[0]?.id ?? null;
  const next = slides[index + 1] ?? slides[index - 1];
  return next?.id ?? null;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.';
}

/**
 * Debounced writer for slide config edits.
 *
 * Typing a prompt fires a change per keystroke. Each slide gets its own
 * timer, so editing one slide never delays the save of another, and the
 * pending patch accumulates rather than sending a request per character.
 */
const pending = new Map<string, { patch: Record<string, unknown>; timer: number }>();
const SAVE_DELAY_MS = 600;

export const useDeck = create<DeckState>((set, get) => {
  /** Pulls the server's copy back over local state after a failed write. */
  const resync = async (): Promise<void> => {
    const id = get().deck?.id;
    if (!id) return;
    try {
      const { deck } = await api.getDeck(id);
      set({ deck });
    } catch {
      // If the reload also fails the banner from the original error stands.
    }
  };

  const flush = async (slideId: string): Promise<void> => {
    const entry = pending.get(slideId);
    const deckId = get().deck?.id;
    if (!entry || !deckId) return;

    pending.delete(slideId);
    window.clearTimeout(entry.timer);

    set({ saveState: 'saving', saveError: null });
    try {
      const { deck } = await api.updateSlide(deckId, slideId, entry.patch);
      // The server's copy wins, but only for slides that are not still being
      // typed into — otherwise a slow response would overwrite newer keystrokes.
      set((state) => {
        if (!state.deck) return state;
        const merged = deck.slides.map((incoming) =>
          pending.has(incoming.id)
            ? (state.deck?.slides.find((s) => s.id === incoming.id) ?? incoming)
            : incoming,
        );
        return { deck: { ...deck, slides: merged }, saveState: 'saved', saveError: null };
      });
    } catch (err) {
      set({ saveState: 'error', saveError: messageOf(err) });
      await resync();
    }
  };

  return {
    deck: null,
    selectedSlideId: null,
    loading: false,
    loadError: null,
    saveState: 'idle',
    saveError: null,

    async load(deckId) {
      set({ loading: true, loadError: null, deck: null, selectedSlideId: null });
      try {
        const { deck } = await api.getDeck(deckId);
        set({
          deck,
          selectedSlideId: deck.slides[0]?.id ?? null,
          loading: false,
          saveState: 'idle',
        });
      } catch (err) {
        set({ loading: false, loadError: messageOf(err) });
      }
    },

    close() {
      for (const entry of pending.values()) window.clearTimeout(entry.timer);
      pending.clear();
      set({ deck: null, selectedSlideId: null, saveState: 'idle', saveError: null });
    },

    select(slideId) {
      set({ selectedSlideId: slideId });
    },

    rename(title) {
      const deck = get().deck;
      if (!deck) return;

      set({ deck: { ...deck, title }, saveState: 'saving' });

      const existing = pending.get('__deck__');
      if (existing) window.clearTimeout(existing.timer);

      const timer = window.setTimeout(() => {
        pending.delete('__deck__');
        void (async () => {
          try {
            await api.updateDeck(deck.id, { title });
            set({ saveState: 'saved', saveError: null });
          } catch (err) {
            set({ saveState: 'error', saveError: messageOf(err) });
            await resync();
          }
        })();
      }, SAVE_DELAY_MS);

      pending.set('__deck__', { patch: { title }, timer });
    },

    async addSlide(kind, afterSlideId) {
      const deck = get().deck;
      if (!deck) return;

      set({ saveState: 'saving', saveError: null });
      try {
        const result = await api.addSlide(deck.id, { kind, afterSlideId });
        set({ deck: result.deck, selectedSlideId: result.slideId, saveState: 'saved' });
      } catch (err) {
        set({ saveState: 'error', saveError: messageOf(err) });
      }
    },

    updateSlideConfig(slideId, patch) {
      const deck = get().deck;
      if (!deck) return;

      // Local first, so typing never stutters.
      set({
        deck: {
          ...deck,
          slides: deck.slides.map((s) =>
            s.id === slideId ? { ...s, config: { ...s.config, ...patch } } : s,
          ),
        },
        saveState: 'saving',
      });

      const existing = pending.get(slideId);
      if (existing) window.clearTimeout(existing.timer);

      const timer = window.setTimeout(() => {
        void flush(slideId);
      }, SAVE_DELAY_MS);

      // Patches accumulate, so editing three fields quickly sends one request.
      pending.set(slideId, { patch: { ...(existing?.patch ?? {}), ...patch }, timer });
    },

    async deleteSlide(slideId) {
      const deck = get().deck;
      if (!deck) return;

      // Drop any queued save for a slide that is about to stop existing.
      const queued = pending.get(slideId);
      if (queued) {
        window.clearTimeout(queued.timer);
        pending.delete(slideId);
      }

      const nextSelection = neighbourOf(deck.slides, slideId);

      set({ saveState: 'saving', saveError: null });
      try {
        const { deck: updated } = await api.deleteSlide(deck.id, slideId);
        set({ deck: updated, selectedSlideId: nextSelection, saveState: 'saved' });
      } catch (err) {
        set({ saveState: 'error', saveError: messageOf(err) });
      }
    },

    async duplicateSlide(slideId) {
      const deck = get().deck;
      if (!deck) return;

      set({ saveState: 'saving', saveError: null });
      try {
        const result = await api.duplicateSlide(deck.id, slideId);
        set({ deck: result.deck, selectedSlideId: result.slideId, saveState: 'saved' });
      } catch (err) {
        set({ saveState: 'error', saveError: messageOf(err) });
      }
    },

    async moveSlide(slideId, toIndex) {
      const deck = get().deck;
      if (!deck) return;

      // Reorder locally so the list settles under the cursor immediately.
      const reordered = [...deck.slides];
      const from = reordered.findIndex((s) => s.id === slideId);
      if (from === -1) return;
      const [moved] = reordered.splice(from, 1);
      if (!moved) return;
      reordered.splice(Math.max(0, Math.min(toIndex, reordered.length)), 0, moved);

      set({ deck: { ...deck, slides: reordered }, saveState: 'saving', saveError: null });

      try {
        const { deck: updated } = await api.moveSlide(deck.id, slideId, toIndex);
        set({ deck: updated, saveState: 'saved' });
      } catch (err) {
        set({ saveState: 'error', saveError: messageOf(err) });
        await resync();
      }
    },
  };
});

/** The currently selected slide, or null. */
export function useSelectedSlide(): Slide | null {
  return useDeck((s) => {
    if (!s.deck || !s.selectedSlideId) return null;
    return s.deck.slides.find((slide) => slide.id === s.selectedSlideId) ?? null;
  });
}
