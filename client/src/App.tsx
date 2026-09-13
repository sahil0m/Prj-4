import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAuth } from './lib/auth-store';
import { SignIn } from './pages/SignIn';
import { Dashboard } from './pages/Dashboard';

/*
 * Everything past the dashboard is fetched when it is first opened.
 *
 * The whole app used to arrive as one file, so reaching the sign-in page
 * meant downloading the deck editor, the presenter view, the admin portal
 * and a calendar -- most of which a given person never opens, and none of
 * which is needed to type a password.
 *
 * Sign-in and the dashboard stay in the main bundle because they are the
 * first thing almost everyone sees, and a spinner on the first screen
 * would be a worse trade than the bytes.
 */
const DeckEditor = lazy(() =>
  import('./pages/DeckEditor').then((m) => ({ default: m.DeckEditor })),
);
const Presenter = lazy(() => import('./pages/Presenter').then((m) => ({ default: m.Presenter })));
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })));
import { Splash } from './components/Splash';
import { TooltipProvider } from './components/Controls';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * Restores the session once on load, then routes.
 *
 * Nothing renders until that check finishes. Showing the sign-in page to a
 * user who is already signed in, even for 200ms, is the flicker that makes
 * an app feel unfinished.
 */
function Shell() {
  const status = useAuth((s) => s.status);
  const restore = useAuth((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  if (status === 'checking') return <Splash />;

  return (
    /* The same splash the session check uses, so a page that arrives over
       a slow connection looks like loading rather than like nothing. */
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route
          path="/signin"
          element={status === 'authenticated' ? <Navigate to="/" replace /> : <SignIn />}
        />

        {/* Where the Google callback lands. The refresh cookie is already set,
          so all this page does is pick the session up and move on. */}
        <Route path="/auth/complete" element={<OAuthComplete />} />

        <Route
          path="/"
          element={status === 'authenticated' ? <Dashboard /> : <Navigate to="/signin" replace />}
        />

        <Route
          path="/decks/:deckId"
          element={status === 'authenticated' ? <DeckEditor /> : <Navigate to="/signin" replace />}
        />

        <Route
          path="/present/:sessionId"
          element={status === 'authenticated' ? <Presenter /> : <Navigate to="/signin" replace />}
        />

        {/* Guarded on the server too: this route only hides the link, it is
          not what keeps a non-admin out. */}
        <Route
          path="/admin"
          element={status === 'authenticated' ? <Admin /> : <Navigate to="/signin" replace />}
        />

        <Route
          path="/settings"
          element={status === 'authenticated' ? <Settings /> : <Navigate to="/signin" replace />}
        />

        <Route
          path="/history"
          element={status === 'authenticated' ? <History /> : <Navigate to="/signin" replace />}
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

function OAuthComplete() {
  const restore = useAuth((s) => s.restore);
  const navigate = useNavigate();

  useEffect(() => {
    void (async () => {
      await restore();
      // v7 types navigate() as possibly returning a promise; nothing here
      // needs to wait on it, so discard it explicitly.
      void navigate('/', { replace: true });
    })();
  }, [restore, navigate]);

  return <Splash message="Finishing sign-in" />;
}

export function App() {
  return (
    <BrowserRouter>
      {/* One provider for the whole app, so individual tooltips need none. */}
      <TooltipProvider>
        {/* Inside the router, so the fallback can tell a live session from
            any other screen and offer the right way out. */}
        <ErrorBoundary>
          <Shell />
        </ErrorBoundary>
      </TooltipProvider>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--color-surface-raised)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-ink)',
          },
        }}
      />
    </BrowserRouter>
  );
}
