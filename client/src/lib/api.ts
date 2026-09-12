import type { SlideKind, SlideConfig } from '@pulse/shared';

/**
 * The API client.
 *
 * Access tokens live in memory only — never localStorage, which any injected
 * script can read. The refresh token sits in an httpOnly cookie the browser
 * sends automatically and JavaScript cannot touch.
 *
 * When a request comes back 401, we transparently refresh once and retry.
 * Concurrent 401s share a single refresh rather than stampeding the server.
 */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  locale: string;
  emailVerified: boolean;
  hasPassword: boolean;
  providers: string[];
}

export interface ApiErrorShape {
  error: string;
  code: string;
  issues?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The message for a specific form field, if the server flagged one. */
  fieldError(field: string): string | undefined {
    return this.issues.find((i) => i.path === field)?.message;
  }
}

/* ------------------------------------------------------------------ */
/* Access token, held in memory                                        */
/* ------------------------------------------------------------------ */

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/* ------------------------------------------------------------------ */
/* Core request                                                        */
/* ------------------------------------------------------------------ */

const BASE = '/api';

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Set on the refresh call itself, so a failure cannot recurse. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

/** Shared in-flight refresh, so ten simultaneous 401s cause one refresh. */
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see
      // the same result before a new attempt can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh = false, signal } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const init: RequestInit = { method, headers, credentials: 'include' };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;

    return fetch(`${BASE}${path}`, init);
  };

  let response = await send();

  // One transparent refresh-and-retry on an expired access token.
  if (response.status === 401 && !skipRefresh) {
    const refreshed = await attemptRefresh();
    if (refreshed) response = await send();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const shape = (parsed ?? {}) as Partial<ApiErrorShape>;
    throw new ApiError(
      response.status,
      shape.code ?? 'unknown',
      shape.error ?? 'Something went wrong.',
      shape.issues ?? [],
    );
  }

  return parsed as T;
}

/* ------------------------------------------------------------------ */
/* Auth endpoints                                                      */
/* ------------------------------------------------------------------ */

interface SessionResponse {
  user: PublicUser;
  accessToken: string;
}

export interface Providers {
  password: boolean;
  google: boolean;
}

export const api = {
  providers: (): Promise<Providers> => request('/auth/providers'),

  async register(input: { email: string; password: string; name: string }): Promise<PublicUser> {
    const data = await request<SessionResponse>('/auth/register', {
      method: 'POST',
      body: input,
    });
    accessToken = data.accessToken;
    return data.user;
  },

  async login(input: { email: string; password: string }): Promise<PublicUser> {
    const data = await request<SessionResponse>('/auth/login', { method: 'POST', body: input });
    accessToken = data.accessToken;
    return data.user;
  },

  /** Restores a session on page load, using only the refresh cookie. */
  async restore(): Promise<PublicUser | null> {
    try {
      const data = await request<SessionResponse>('/auth/refresh', {
        method: 'POST',
        skipRefresh: true,
      });
      accessToken = data.accessToken;
      return data.user;
    } catch {
      accessToken = null;
      return null;
    }
  },

  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
    accessToken = null;
  },

  async logoutEverywhere(): Promise<void> {
    await request('/auth/logout-everywhere', { method: 'POST' });
    accessToken = null;
  },

  me: (): Promise<{ user: PublicUser }> => request('/auth/me'),

  changePassword: (input: { currentPassword: string; newPassword: string }): Promise<void> =>
    request('/auth/change-password', { method: 'POST', body: input }),

  sessions: (): Promise<{ sessions: ActiveSession[] }> => request('/auth/sessions'),

  revokeSession: (id: string): Promise<void> =>
    request(`/auth/sessions/${id}`, { method: 'DELETE' }),

  /** Full-page redirect, because OAuth needs a real navigation. */
  startGoogleSignIn(): void {
    window.location.href = `${BASE}/auth/google`;
  },

  /* ---------------- decks ---------------- */

  listDecks: (
    options: { includeArchived?: boolean; search?: string } = {},
  ): Promise<{
    decks: DeckSummary[];
  }> => {
    const params = new URLSearchParams();
    if (options.includeArchived) params.set('includeArchived', 'true');
    if (options.search) params.set('search', options.search);
    const query = params.toString();
    return request(`/decks${query ? `?${query}` : ''}`);
  },

  createDeck: (input: { title?: string; slideKinds?: SlideKind[] } = {}): Promise<DeckResponse> =>
    request('/decks', { method: 'POST', body: input }),

  getDeck: (deckId: string): Promise<DeckResponse> => request(`/decks/${deckId}`),

  updateDeck: (deckId: string, input: UpdateDeckInput): Promise<DeckResponse> =>
    request(`/decks/${deckId}`, { method: 'PATCH', body: input }),

  deleteDeck: (deckId: string): Promise<void> => request(`/decks/${deckId}`, { method: 'DELETE' }),

  duplicateDeck: (deckId: string): Promise<DeckResponse> =>
    request(`/decks/${deckId}/duplicate`, { method: 'POST' }),

  archiveDeck: (deckId: string, archived: boolean): Promise<DeckResponse> =>
    request(`/decks/${deckId}/archive`, { method: 'POST', body: { archived } }),

  addSlide: (
    deckId: string,
    input: { kind: SlideKind; afterSlideId?: string; config?: unknown },
  ): Promise<DeckResponse & { slideId: string }> =>
    request(`/decks/${deckId}/slides`, { method: 'POST', body: input }),

  /**
   * Sends only the fields that changed; the server merges them over the
   * stored config, so one panel's save cannot wipe another's fields.
   */
  updateSlide: (
    deckId: string,
    slideId: string,
    patch: Record<string, unknown>,
  ): Promise<DeckResponse> =>
    request(`/decks/${deckId}/slides/${slideId}`, { method: 'PUT', body: patch }),

  deleteSlide: (deckId: string, slideId: string): Promise<DeckResponse> =>
    request(`/decks/${deckId}/slides/${slideId}`, { method: 'DELETE' }),

  duplicateSlide: (deckId: string, slideId: string): Promise<DeckResponse & { slideId: string }> =>
    request(`/decks/${deckId}/slides/${slideId}/duplicate`, { method: 'POST' }),

  moveSlide: (deckId: string, slideId: string, toIndex: number): Promise<DeckResponse> =>
    request(`/decks/${deckId}/slides/${slideId}/move`, { method: 'POST', body: { toIndex } }),

  /* ---------------- sessions ---------------- */

  startSession: (deckId: string): Promise<{ session: LiveSession }> =>
    request('/sessions', { method: 'POST', body: { deckId } }),

  getSession: (
    sessionId: string,
  ): Promise<{
    session: LiveSession;
    snapshot: {
      title: string;
      slides: { id: string; kind: string; position: number; config: Record<string, unknown> }[];
    };
  }> => request(`/sessions/${sessionId}`),

  endSession: (sessionId: string): Promise<{ session: LiveSession }> =>
    request(`/sessions/${sessionId}/end`, { method: 'POST' }),
};

export interface LiveSession {
  id: string;
  deckId: string;
  title: string;
  joinCode: string;
  joinSlug: string;
  /** Where the audience should go, as the server knows itself. */
  joinUrl: string;
  /** The same, with the code already filled in — used for the QR code. */
  joinLink: string;
  state: string;
  mode: string;
  currentSlideId: string | null;
  participationOpen: boolean;
  resultsVisible: boolean;
  startedAt: string;
  endedAt: string | null;
}

/* ------------------------------------------------------------------ */
/* Deck shapes                                                         */
/* ------------------------------------------------------------------ */

export interface DeckSummary {
  id: string;
  title: string;
  description: string;
  slideCount: number;
  preview: SlideKind[];
  theme: { preset: string; accent: string; mode: 'dark' | 'light' };
  archived: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface Slide {
  id: string;
  kind: SlideKind;
  position: number;
  config: SlideConfig;
}

export interface Deck {
  id: string;
  title: string;
  description: string;
  slides: Slide[];
  theme: Record<string, unknown>;
  settings: Record<string, unknown>;
  revision: number;
  archived: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface DeckResponse {
  deck: Deck;
}

export interface UpdateDeckInput {
  title?: string;
  description?: string;
  theme?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface ActiveSession {
  id: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
