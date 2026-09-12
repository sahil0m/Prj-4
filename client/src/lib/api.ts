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
};

export interface ActiveSession {
  id: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}
