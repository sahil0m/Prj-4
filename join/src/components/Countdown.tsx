import { useEffect, useState } from 'react';
import styles from './Countdown.module.css';

/**
 * The quiz clock, as a bar.
 *
 * Only the bar here: the presenter's ring uses an animation library this
 * app deliberately does not carry, and a phone has no room for one anyway.
 *
 * Driven from the server's end time rather than a local counter, so every
 * screen agrees and a tab that was backgrounded catches up rather than
 * drifting behind.
 */
/** A compact bar, for a phone where a ring would crowd the answer. */
export function CountdownBar({ endsAt }: { endsAt: string | null }) {
  const [remaining, setRemaining] = useState(() => secondsUntil(endsAt));

  useEffect(() => {
    if (endsAt === null) return;

    const timer = setInterval(() => {
      setRemaining(secondsUntil(endsAt));
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [endsAt]);

  if (endsAt === null) return null;

  const total = totalSeconds(endsAt, remaining);
  const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;

  return (
    <div
      className={styles.bar}
      data-urgency={remaining <= 5 ? 'critical' : remaining <= 10 ? 'warning' : 'normal'}
    >
      <div className={styles.barFill} style={{ width: `${String(fraction * 100)}%` }} />
      <span className={styles.barLabel}>{Math.max(0, Math.ceil(remaining))}s</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function secondsUntil(endsAt: string | null): number {
  if (endsAt === null) return 0;

  const end = new Date(endsAt).getTime();
  if (Number.isNaN(end)) return 0;

  return Math.max(0, (end - Date.now()) / 1000);
}

/**
 * The countdown's full length, remembered from the first reading.
 *
 * The server sends only an end time, so the total has to be inferred. The
 * highest value seen for a given end time is the length, which is right
 * from the moment the clock starts and stays right as it runs down.
 */
const totals = new Map<string, number>();

function totalSeconds(endsAt: string, remaining: number): number {
  const known = totals.get(endsAt) ?? 0;

  if (remaining > known) {
    totals.set(endsAt, remaining);

    // The map would otherwise grow for the life of the page; a session has
    // no reason to hold more than a few clocks at once.
    if (totals.size > 20) {
      const oldest = totals.keys().next().value;
      if (oldest !== undefined) totals.delete(oldest);
    }

    return remaining;
  }

  return known;
}
