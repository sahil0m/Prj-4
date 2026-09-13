import { motion, AnimatePresence } from 'motion/react';
import { Trophy, ChevronUp, ChevronDown, Minus, Flame } from 'lucide-react';
import type { LeaderboardEntry } from '@pulse/shared';
import styles from './Leaderboard.module.css';

/**
 * The standings, on the big screen.
 *
 * Rows animate between positions rather than jumping, because watching
 * someone overtake is most of the reason a room plays at all. Motion's
 * layout animation does the work: the list is re-sorted and each row slides
 * from where it was to where it now belongs.
 */
export function Leaderboard({
  entries,
  /** Rows beyond this are cut; a projector cannot show forty names legibly. */
  limit = 10,
}: {
  entries: LeaderboardEntry[];
  limit?: number;
}) {
  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <Trophy size={34} className={styles.emptyIcon} />
        <p className={styles.emptyTitle}>No scores yet</p>
        <p className={styles.emptyBody}>Answers to a quiz slide will appear here.</p>
      </div>
    );
  }

  const shown = entries.slice(0, limit);
  const others = entries.length - shown.length;

  return (
    <div className={styles.board}>
      <ol className={styles.list}>
        <AnimatePresence initial={false}>
          {shown.map((entry) => (
            <motion.li
              key={entry.participantId}
              className={styles.row}
              data-rank={entry.rank <= 3 ? entry.rank : undefined}
              layout
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -18 }}
              transition={{
                // A spring rather than a fixed duration: a row moving one
                // place should settle faster than one climbing five.
                layout: { type: 'spring', stiffness: 240, damping: 28 },
                duration: 0.25,
              }}
            >
              <span className={styles.rank}>
                {entry.rank <= 3 ? <Medal rank={entry.rank} /> : entry.rank}
              </span>

              <span className={styles.name}>{entry.displayName}</span>

              <Movement change={entry.change} />

              <span className={styles.stats}>
                <span className={styles.correct} title="Correct out of answered">
                  {entry.correctCount}/{entry.answeredCount}
                </span>

                {/* Accuracy, because 3/5 and 30/50 are the same skill and a
                    raw count makes them look different. */}
                <span className={styles.accuracy} data-strong={entry.accuracy >= 80}>
                  {entry.accuracy}%
                </span>

                {/* A streak is the thing people talk about afterwards. */}
                {entry.bestStreak >= 3 && (
                  <span className={styles.streak} title="Longest run of correct answers">
                    <Flame size={12} />
                    {entry.bestStreak}
                  </span>
                )}

                {entry.averageSeconds !== null && (
                  <span className={styles.speed} title="Average time on correct answers">
                    {entry.averageSeconds}s
                  </span>
                )}
              </span>

              <motion.span
                className={styles.score}
                // The number itself pops when it changes, so a score rising
                // without a position change is still visible.
                key={entry.score}
                initial={{ scale: 1.25, color: 'var(--color-positive)' }}
                animate={{ scale: 1, color: 'var(--color-ink)' }}
                transition={{ duration: 0.4 }}
              >
                {entry.score.toLocaleString()}
              </motion.span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>

      {others > 0 && (
        <p className={styles.others}>
          and {others} more {others === 1 ? 'player' : 'players'}
        </p>
      )}
    </div>
  );
}

/** Gold, silver and bronze read faster than the numbers 1, 2 and 3. */
function Medal({ rank }: { rank: number }) {
  return (
    <span className={styles.medal} data-rank={rank} aria-label={`Rank ${String(rank)}`}>
      <Trophy size={18} />
    </span>
  );
}

/**
 * How far someone moved since the last slide.
 *
 * Positive means climbed, which is how an arrow reads to a room.
 */
function Movement({ change }: { change: number | null }) {
  if (change === null) return <span className={styles.movement} />;

  if (change === 0) {
    return (
      <span className={styles.movement} data-direction="none" aria-label="No change">
        <Minus size={13} />
      </span>
    );
  }

  const climbed = change > 0;

  return (
    <span
      className={styles.movement}
      data-direction={climbed ? 'up' : 'down'}
      aria-label={`${climbed ? 'Up' : 'Down'} ${String(Math.abs(change))}`}
    >
      {climbed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      {Math.abs(change)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Podium                                                              */
/* ------------------------------------------------------------------ */

/**
 * The top three, for the end of a quiz.
 *
 * Second, first, third — the order a physical podium is built in, so the
 * winner is centre stage rather than on the left.
 */
export function Podium({ entries }: { entries: LeaderboardEntry[] }) {
  const top = entries.slice(0, 3);
  if (top.length === 0) return null;

  const order = [top[1], top[0], top[2]].filter(Boolean) as LeaderboardEntry[];

  return (
    <div className={styles.podium}>
      {order.map((entry) => (
        <motion.div
          key={entry.participantId}
          className={styles.podiumPlace}
          data-rank={entry.rank}
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            // Third, then second, then first: the winner lands last, which
            // is the moment the room is waiting for.
            delay: (4 - Math.min(entry.rank, 3)) * 0.18,
            type: 'spring',
            stiffness: 180,
            damping: 20,
          }}
        >
          <span className={styles.podiumName}>{entry.displayName}</span>
          <span className={styles.podiumScore}>{entry.score.toLocaleString()}</span>
          <div className={styles.podiumBlock} data-rank={entry.rank}>
            <span className={styles.podiumRank}>{entry.rank}</span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
