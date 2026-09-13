import { useState } from 'react';
import type { ParticipantSlide } from '@pulse/shared';
import type { SessionConnection } from '../lib/session';
import styles from './Pacer.module.css';

/**
 * Moving through the deck yourself, in an audience-paced session.
 *
 * Only the server knows where someone actually is, so this asks and waits
 * rather than guessing: the new slide arrives as a `slide:show` on the same
 * path a presenter-led session uses, and the position shown here comes back
 * with it. Pressing twice quickly cannot skip a slide, because the second
 * press is refused while the first is still in flight.
 *
 * It sits outside the question area deliberately. After answering, the
 * confirmation screen replaces the question, and that is exactly the moment
 * someone needs to move on — a control inside the question would vanish
 * when it is most needed.
 */
export function Pacer({
  slide,
  connection,
}: {
  slide: ParticipantSlide;
  connection: SessionConnection;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Presenter-paced sessions follow one screen; a phone that could move
  // itself would be answering a different question from the one on the wall.
  if (!slide.selfPaced) return null;

  // The server clamps at both ends, so these only remove a press that would
  // do nothing; they are not what enforces the boundary.
  const atStart = slide.index <= 0;
  const atEnd = slide.index >= slide.total - 1;

  const go = (direction: 'next' | 'previous') => {
    if (busy) return;
    setBusy(true);
    setError(null);

    void connection.move(direction).then((result) => {
      setBusy(false);
      if (!result.ok) setError(result.message);
    });
  };

  return (
    <nav className={styles.pacer} aria-label="Move through the deck">
      <button
        type="button"
        className={styles.step}
        onClick={() => {
          go('previous');
        }}
        disabled={busy || atStart}
        aria-label="Previous question"
      >
        <span aria-hidden="true">←</span> Back
      </button>

      {/* Position rather than a progress bar: "3 of 12" tells someone how
          much is left, which is the question they are actually asking. */}
      <span className={styles.position} aria-live="polite">
        {slide.index + 1} of {slide.total}
      </span>

      <button
        type="button"
        className={styles.step}
        data-primary="true"
        onClick={() => {
          go('next');
        }}
        disabled={busy || atEnd}
        aria-label={atEnd ? 'Last question' : 'Next question'}
      >
        {atEnd ? 'Done' : 'Next'} <span aria-hidden="true">→</span>
      </button>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </nav>
  );
}
