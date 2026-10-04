import { create } from 'zustand';
import { SOCKET_URL } from './origin';
import { io, type Socket } from 'socket.io-client';
import type {
  DeckThemeLike,
  ServerEvents,
  ClientEvents,
  SessionState,
  SlideResults,
  LeaderboardEntry,
} from '@pulse/shared';
import { getAccessToken, api, ApiError } from './api';

/**
 * The presenter's live session.
 *
 * Results arrive as whole tallies rather than individual answers, so a slide
 * with a thousand responses costs one small message rather than a thousand.
 */

/** A reaction floating up the screen. Never stored; purely a moment. */
export interface FloatingReaction {
  id: number;
  emoji: string;
}

/** A question from the audience, waiting for the presenter. */
export interface AudienceQuestion {
  id: string;
  text: string;
  displayName: string;
  upvotes: number;
  answered: boolean;
}

export interface SessionSnapshot {
  title: string;
  slides: { id: string; kind: string; position: number; config: Record<string, unknown> }[];
}

export interface PresenterSession {
  id: string;
  title: string;
  joinCode: string;
  joinSlug: string;
  joinUrl: string;
  joinUrls: string[];
  joinLink: string;
  state: string;
  /** Chosen in the editor; drives the accent the room sees. */
  /** The deck's colours, frozen with the session. */
  theme?: DeckThemeLike;
  currentSlideId: string | null;
}

interface PresenterStore {
  session: PresenterSession | null;
  snapshot: SessionSnapshot | null;
  state: SessionState | null;
  results: SlideResults | null;
  leaderboard: LeaderboardEntry[];
  reactions: FloatingReaction[];
  questions: AudienceQuestion[];
  connected: boolean;
  loading: boolean;
  error: string | null;

  open: (sessionId: string) => Promise<void>;
  close: () => void;

  goTo: (slideId: string) => void;
  next: () => void;
  previous: () => void;
  setParticipation: (open: boolean) => void;
  removeResponse: (responseId: string) => void;
  dismissReaction: (id: number) => void;
  markAnswered: (id: string) => void;
  setResultsVisible: (visible: boolean) => void;
  end: () => Promise<void>;
}

let socket: Socket<ServerEvents, ClientEvents> | null = null;

// A monotonic id, so two reactions in the same millisecond still get
// distinct React keys.
let reactionCounter = 0;
function nextReactionId(): number {
  reactionCounter += 1;
  return reactionCounter;
}

export const usePresenter = create<PresenterStore>((set, get) => ({
  session: null,
  snapshot: null,
  state: null,
  results: null,
  leaderboard: [],
  reactions: [],
  questions: [],
  connected: false,
  loading: false,
  error: null,

  async open(sessionId) {
    set({ loading: true, error: null });

    try {
      const data = await api.getSession(sessionId);
      set({ session: data.session, snapshot: data.snapshot, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof ApiError ? err.message : 'That session could not be opened.',
      });
      return;
    }

    socket?.close();

    // The access token goes through `auth`, not a query string, so it stays
    // out of server logs and proxy records.
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      auth: { token: getAccessToken() },
    });

    socket.on('connect', () => {
      set({ connected: true });
      socket?.emit('presenter:join', { sessionId }, (result) => {
        if (!result.ok) set({ error: result.message });
      });
    });

    socket.on('disconnect', () => {
      set({ connected: false });
    });

    socket.on('session:state', (state) => {
      set({ state });
    });

    socket.on('results:update', (results) => {
      // Only for the slide on screen; a late tally for a previous slide
      // would otherwise flash over the current one.
      if (results.slideId === get().state?.currentSlideId) set({ results });
    });

    socket.on('leaderboard:update', ({ entries }) => {
      set({ leaderboard: entries });
    });

    socket.on('participants:count', ({ count }) => {
      // The header counter updates as people arrive. Without this it froze
      // at whatever the count was when the presenter connected, which made
      // a filling room look empty.
      set((current) =>
        current.state ? { state: { ...current.state, participantCount: count } } : {},
      );
    });

    socket.on('response:removed', ({ slideId }) => {
      // A removed answer changes the tally, so the presenter's own copy is
      // refreshed rather than left showing a count that includes it.
      if (slideId === get().state?.currentSlideId) {
        set({ results: null });
      }
    });

    socket.on('reaction', ({ emoji }) => {
      // Capped, because a room that all taps at once would otherwise put a
      // thousand animating elements on the screen at the same moment.
      set((current) => ({
        reactions: [...current.reactions.slice(-24), { id: nextReactionId(), emoji }],
      }));
    });

    socket.on('question:new', (question) => {
      set((current) => ({
        questions: [{ ...question, answered: false }, ...current.questions].slice(0, 100),
      }));
    });

    socket.on('session:ended', () => {
      set({ connected: false });
    });
  },

  close() {
    socket?.close();
    socket = null;
    set({
      session: null,
      snapshot: null,
      state: null,
      results: null,
      leaderboard: [],
      reactions: [],
      questions: [],
      connected: false,
      error: null,
    });
  },

  goTo(slideId) {
    // Cleared immediately so the previous slide's numbers never appear under
    // the new slide's question.
    set({ results: null });
    socket?.emit('presenter:goto', { slideId }, () => {
      // State comes back over session:state.
    });
  },

  next() {
    const { snapshot, state } = get();
    if (!snapshot || !state) return;

    const index = snapshot.slides.findIndex((s) => s.id === state.currentSlideId);
    const target = snapshot.slides[index + 1];
    if (target) get().goTo(target.id);
  },

  previous() {
    const { snapshot, state } = get();
    if (!snapshot || !state) return;

    const index = snapshot.slides.findIndex((s) => s.id === state.currentSlideId);
    const target = snapshot.slides[index - 1];
    if (target) get().goTo(target.id);
  },

  dismissReaction(id) {
    set((current) => ({ reactions: current.reactions.filter((r) => r.id !== id) }));
  },

  markAnswered(id) {
    set((current) => ({
      questions: current.questions.map((q) => (q.id === id ? { ...q, answered: true } : q)),
    }));
  },

  /**
   * Takes one answer off the wall.
   *
   * A soft delete on the server, so the record survives for anyone who
   * later asks what was said; the live tally simply stops counting it.
   */
  removeResponse(responseId) {
    socket?.emit('presenter:remove-response', { responseId }, () => undefined);
  },

  setParticipation(open) {
    socket?.emit('presenter:participation', { open }, () => undefined);
  },

  setResultsVisible(visible) {
    socket?.emit('presenter:results-visible', { visible }, () => undefined);
  },

  /**
   * Ends the session for everyone.
   *
   * This used to go over the socket alone, and resolve immediately when
   * there was no socket -- so a presenter whose connection had dropped
   * pressed End, was taken back to their decks, and left a live session
   * behind them. The join code kept working and people kept joining,
   * until the cleanup job closed it a day later.
   *
   * The socket is still tried first, because it tells every phone at
   * once. But it is only an optimisation now: the REST call is what
   * actually decides, and it runs whether the socket answered or not.
   * Ending a session is the one action here that must not half-happen.
   */
  async end() {
    const sessionId = get().session?.id ?? null;

    await new Promise<void>((resolve) => {
      if (!socket?.connected) {
        resolve();
        return;
      }

      // Without a deadline a server that never acknowledges leaves the
      // button spinning for as long as the presenter is willing to wait.
      const timer = setTimeout(resolve, 3000);

      socket.emit('presenter:end', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (sessionId) {
      try {
        await api.endSession(sessionId);
      } catch (err) {
        // Already closed is the expected outcome when the socket got
        // there first, and is not worth reporting.
        if (!(err instanceof ApiError)) throw err;
      }
    }

    get().close();
  },
}));
