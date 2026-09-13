import { Component, type ReactNode, type ErrorInfo } from 'react';
import { RefreshCw, Home, AlertTriangle } from 'lucide-react';
import styles from './ErrorBoundary.module.css';

/**
 * The last line of defence against a white screen.
 *
 * React unmounts the whole tree when a render throws, so without this any
 * single bad value takes the entire app down to a blank page -- on a
 * projector, in front of a room, with no way back but a reload the
 * presenter has to think of themselves.
 *
 * The recovery offered depends on where it happened. A session is the one
 * place where reloading is genuinely the right move: the join code and
 * every answer live on the server, so the room keeps its place and the
 * presenter reconnects to exactly where they were.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than sent anywhere: this product has no
    // telemetry, and adding a reporting service would be a cost and a
    // privacy decision nobody asked for.
    console.error('Unhandled error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const presenting = window.location.pathname.startsWith('/present/');

    return (
      <div className={styles.wrap} role="alert">
        <div className={styles.card}>
          <span className={styles.icon}>
            <AlertTriangle size={26} />
          </span>

          <h1 className={styles.title}>Something broke</h1>

          <p className={styles.body}>
            {presenting
              ? 'Your session is safe. Every answer is stored on the server, so reloading puts you back exactly where you were — the room does not need to rejoin.'
              : 'This screen stopped working. Nothing you saved has been lost.'}
          </p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                window.location.reload();
              }}
            >
              <RefreshCw size={16} />
              Reload
            </button>

            {!presenting && (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  window.location.href = '/';
                }}
              >
                <Home size={16} />
                Dashboard
              </button>
            )}
          </div>

          {/* Collapsed, because the message means nothing to most people --
              but someone reporting this needs to be able to copy it. */}
          <details className={styles.details}>
            <summary className={styles.summary}>Technical details</summary>
            <pre className={styles.trace}>{error.message}</pre>
          </details>
        </div>
      </div>
    );
  }
}
