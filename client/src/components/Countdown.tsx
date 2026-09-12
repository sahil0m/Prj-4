import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import styles from './Countdown.module.css';

/**
 * The clock a quiz runs on.
 *
 * The server already measured elapsed time for scoring; without something
 * on screen the room had no idea it was being timed, which removes the
 * urgency that makes a quiz work.
 *
 * Driven from the server's end time rather than a local counter, so every
 * screen agrees and a tab that was backgrounded catches up rather than
 * drifting behind.
 */
export function Countdown({
  endsAt,
  onFinish,
}: {
  /** ISO timestamp from the server, or null when no clock is running. */
  endsAt: string | null;
  onFinish?: () => void;
}) {
  const [remaining, setRemaining] = useState(() => secondsUntil(endsAt));

  useEffect(() => {
    if (endsAt === null) return;

    setRemaining(secondsUntil(endsAt));

    // Ticks four times a second rather than once: a ring that only moves on
    // whole seconds looks broken next to a number that does the same.
    const timer = setInterval(() => {
      const left = secondsUntil(endsAt);
      setRemaining(left);

      if (left <= 0) {
        clearInterval(timer);
        onFinish?.();
      }
    }, 250);

    return () => {
      clearInterval(timer);
    };
  }, [endsAt, onFinish]);

  if (endsAt === null) return null;

  const total = totalSeconds(endsAt, remaining);
  const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;

  // The last few seconds turn red, which is the signal people actually
  // respond to — a number alone does not read from the back of a room.
  const urgency = remaining <= 5 ? 'critical' : remaining <= 10 ? 'warning' : 'normal';

  const circumference = 2 * Math.PI * 46;

  return (
    <div className={styles.countdown} data-urgency={urgency} role="timer" aria-live="off">
      <svg viewBox="0 0 100 100" className={styles.ring} aria-hidden="true">
        <circle cx="50" cy="50" r="46" className={styles.track} />
        <motion.circle
          cx="50"
          cy="50"
          r="46"
          className={styles.progress}
          strokeDasharray={circumference}
          // Drawn from the top and anticlockwise, which is how a countdown
          // reads; the default would start from the right.
          animate={{ strokeDashoffset: circumference * (1 - fraction) }}
          transition={{ duration: 0.25, ease: 'linear' }}
        />
      </svg>

      <motion.span
        className={styles.number}
        // A pulse on each of the final seconds, so the urgency is felt
        // rather than only read.
        key={remaining <= 5 ? remaining : 'steady'}
        animate={remaining <= 5 ? { scale: [1.25, 1] } : {}}
        transition={{ duration: 0.3 }}
      >
        {Math.max(0, Math.ceil(remaining))}
      </motion.span>
    </div>
  );
}

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
