import { Component, type ReactNode, type ErrorInfo } from 'react';
import styles from './ErrorBoundary.module.css';

/**
 * A crash on a phone, handled.
 *
 * Worse here than on the presenter's laptop: someone in a room of a
 * hundred people cannot debug a white screen, cannot ask for help without
 * interrupting, and will simply stop participating. The answer they
 * already sent is safe on the server, and reloading rejoins the session
 * they are already in -- so the only thing this has to do is say so and
 * offer the button.
 *
 * No icon library and no animation: this file has to work when the rest of
 * the app did not, and every import is one more thing that could be the
 * reason it did not.
 */
interface State {
  error: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: false };

  static override getDerivedStateFromError(): State {
    return { error: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className={styles.wrap} role="alert">
        <p className={styles.title}>Something went wrong</p>
        <p className={styles.body}>
          Your answers are saved. Reloading puts you back in the same session.
        </p>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
