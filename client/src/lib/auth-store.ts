import { create } from 'zustand';
import { api, ApiError, type PublicUser, type Providers } from './api';

/**
 * Authentication state.
 *
 * `status` is deliberately a four-state machine rather than a boolean pair.
 * "Not signed in" and "we have not checked yet" need different screens: the
 * second must show nothing rather than flashing the sign-in page at a user
 * who is already authenticated.
 */
export type AuthStatus = 'checking' | 'authenticated' | 'anonymous' | 'error';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  providers: Providers;
  /** Set while a sign-in or sign-up request is running. */
  busy: boolean;
  /** Last error, for display on the form. */
  error: ApiError | null;

  restore: () => Promise<void>;
  loadProviders: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<boolean>;
  signUp: (name: string, email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: 'checking',
  user: null,
  providers: { password: true, google: false },
  busy: false,
  error: null,

  async restore() {
    const user = await api.restore();
    set(user ? { status: 'authenticated', user } : { status: 'anonymous', user: null });
  },

  async loadProviders() {
    try {
      set({ providers: await api.providers() });
    } catch {
      // A failure here just means the Google button stays hidden, which is
      // the correct fallback.
    }
  },

  async signIn(email, password) {
    set({ busy: true, error: null });
    try {
      const user = await api.login({ email, password });
      set({ status: 'authenticated', user, busy: false });
      return true;
    } catch (err) {
      set({
        busy: false,
        error:
          err instanceof ApiError ? err : new ApiError(0, 'network', 'Could not reach the server.'),
      });
      return false;
    }
  },

  async signUp(name, email, password) {
    set({ busy: true, error: null });
    try {
      const user = await api.register({ name, email, password });
      set({ status: 'authenticated', user, busy: false });
      return true;
    } catch (err) {
      set({
        busy: false,
        error:
          err instanceof ApiError ? err : new ApiError(0, 'network', 'Could not reach the server.'),
      });
      return false;
    }
  },

  async signOut() {
    try {
      await api.logout();
    } finally {
      // Sign out locally even if the request failed, so the user is never
      // stuck looking at a signed-in screen they asked to leave.
      set({ status: 'anonymous', user: null, error: null });
    }
  },

  clearError() {
    set({ error: null });
  },
}));
