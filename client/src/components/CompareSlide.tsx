import { useEffect, useState } from 'react';
import { Results } from './Results';
import { api } from '../lib/api';
import type { SlideResults } from '@pulse/shared';
import styles from './CompareSlide.module.css';

/**
 * Two slides' results, side by side.
 *
 * A Compare slide previously rendered nothing at all: it could be added,
 * configured and presented, and the room saw an empty screen. It is the
 * one content slide that needs data, which is presumably how it was
 * missed -- everything else on the stage reads from the current slide.
 *
 * Before and after is the usual use: ask the room something, teach, ask
 * again, and put the two next to each other. That only lands if both are
 * on screen together, so this fetches rather than waiting for the socket,
 * which only ever pushes the slide currently being presented.
 */
export function CompareSlide({
  sessionId,
  slideIdA,
  slideIdB,
  labelA,
  labelB,
}: {
  sessionId: string;
  slideIdA: string;
  slideIdB: string;
  labelA: string;
  labelB: string;
}) {
  const a = useSlideResults(sessionId, slideIdA);
  const b = useSlideResults(sessionId, slideIdB);

  if (slideIdA === '' || slideIdB === '') {
    return (
      <p className={styles.unset}>
        Pick two slides to compare in the editor, and their results will show here side by side.
      </p>
    );
  }

  return (
    <div className={styles.compare}>
      <section className={styles.side}>
        <h2 className={styles.label}>{labelA}</h2>
        <Pane state={a} />
      </section>

      <section className={styles.side}>
        <h2 className={styles.label}>{labelB}</h2>
        <Pane state={b} />
      </section>
    </div>
  );
}

type State =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; results: SlideResults };

function Pane({ state }: { state: State }) {
  if (state.status === 'loading') return <p className={styles.note}>Loading…</p>;

  // Named plainly rather than blamed on the network: the usual cause is a
  // slide that was deleted from the deck after being chosen here.
  if (state.status === 'error') return <p className={styles.note}>That slide is not available.</p>;

  return <Results results={state.results} revealCorrect />;
}

/**
 * Fetches one slide's results.
 *
 * Polled rather than pushed. A Compare slide usually shows two questions
 * that are already closed, so this is almost always static -- but a
 * presenter may leave both open, and a stale screen would be worse than a
 * request every few seconds.
 */
function useSlideResults(sessionId: string, slideId: string): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (slideId === '') return;

    let cancelled = false;

    const load = () => {
      void api
        .slideResults(sessionId, slideId)
        .then(({ results }) => {
          if (!cancelled) setState({ status: 'ready', results });
        })
        .catch(() => {
          if (!cancelled) setState({ status: 'error' });
        });
    };

    load();
    const timer = setInterval(load, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, slideId]);

  return state;
}
