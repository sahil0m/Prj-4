import { useEffect, useState } from 'react';
import type { LeaderboardEntry } from '@pulse/shared';
import type { SessionConnection } from '../lib/session';
import styles from './ActionBar.module.css';

/**
 * The bar along the bottom of a live session.
 *
 * Three things a participant can do besides answer: react, ask something,
 * and see where they stand. All three are one tap away and none of them
 * covers the question — someone reaching for the scoreboard mid-question
 * should not lose their place.
 */

type Panel = 'none' | 'reactions' | 'question' | 'scores';

const REACTIONS: { emoji: 'clap' | 'heart' | 'laugh' | 'wow' | 'thumbsUp'; glyph: string }[] = [
  { emoji: 'clap', glyph: '👏' },
  { emoji: 'heart', glyph: '❤️' },
  { emoji: 'laugh', glyph: '😂' },
  { emoji: 'wow', glyph: '😮' },
  { emoji: 'thumbsUp', glyph: '👍' },
];

export function ActionBar({
  connection,
  showScores,
}: {
  connection: SessionConnection;
  /** Only shown for a quiz deck; a scoreboard with no scores is noise. */
  showScores: boolean;
}) {
  const [panel, setPanel] = useState<Panel>('none');

  const toggle = (next: Panel) => {
    setPanel((current) => (current === next ? 'none' : next));
  };

  return (
    <>
      {panel === 'reactions' && (
        <ReactionRow
          onPick={(emoji) => {
            connection.reaction(emoji);
            setPanel('none');
          }}
        />
      )}

      {panel === 'question' && (
        <QuestionBox
          connection={connection}
          onDone={() => {
            setPanel('none');
          }}
        />
      )}

      {panel === 'scores' && (
        <ScorePanel
          connection={connection}
          onClose={() => {
            setPanel('none');
          }}
        />
      )}

      <nav className={styles.bar}>
        <button
          type="button"
          className={styles.action}
          data-active={panel === 'reactions'}
          onClick={() => {
            toggle('reactions');
          }}
        >
          <span className={styles.actionGlyph} aria-hidden="true">
            👏
          </span>
          React
        </button>

        <button
          type="button"
          className={styles.action}
          data-active={panel === 'question'}
          onClick={() => {
            toggle('question');
          }}
        >
          <span className={styles.actionGlyph} aria-hidden="true">
            ✋
          </span>
          Ask
        </button>

        {showScores && (
          <button
            type="button"
            className={styles.action}
            data-active={panel === 'scores'}
            onClick={() => {
              toggle('scores');
            }}
          >
            <span className={styles.actionGlyph} aria-hidden="true">
              🏆
            </span>
            Scores
          </button>
        )}
      </nav>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Reactions                                                           */
/* ------------------------------------------------------------------ */

function ReactionRow({ onPick }: { onPick: (emoji: (typeof REACTIONS)[number]['emoji']) => void }) {
  return (
    <div className={styles.reactions}>
      {REACTIONS.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className={styles.reaction}
          aria-label={reaction.emoji}
          onClick={() => {
            onPick(reaction.emoji);
          }}
        >
          {reaction.glyph}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */

function QuestionBox({
  connection,
  onDone,
}: {
  connection: SessionConnection;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;

    setBusy(true);
    setError(null);

    const result = await connection.question(trimmed);
    setBusy(false);

    if (result.ok) {
      setSent(true);
      setText('');
      // Held briefly so the confirmation is actually seen, rather than the
      // panel vanishing the instant it succeeds.
      setTimeout(onDone, 1200);
      return;
    }

    setError(result.message);
  };

  if (sent) {
    return (
      <div className={styles.panel}>
        <p className={styles.sentNote}>Sent to the presenter</p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <textarea
        className={styles.questionInput}
        value={text}
        rows={2}
        maxLength={500}
        autoFocus
        placeholder="Ask the presenter something"
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
      />

      {error !== null && <p className={styles.panelError}>{error}</p>}

      <button
        type="button"
        className={styles.panelButton}
        disabled={text.trim() === '' || busy}
        onClick={() => {
          void send();
        }}
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scores                                                              */
/* ------------------------------------------------------------------ */

function ScorePanel({
  connection,
  onClose,
}: {
  connection: SessionConnection;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void connection.leaderboard().then((result) => {
      if (cancelled) return;

      if (result.ok) {
        setEntries(result.entries);
        setYou(result.you);
      } else {
        setError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  if (error !== null) {
    return (
      <div className={styles.panel}>
        <p className={styles.panelError}>{error}</p>
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className={styles.panel}>
        <p className={styles.sentNote}>Loading…</p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className={styles.panel}>
        <p className={styles.sentNote}>No scores yet</p>
      </div>
    );
  }

  // The top few, plus the player's own row if they are further down — being
  // 34th is still worth seeing, and scrolling a phone list to find yourself
  // during a live question is not something anyone will do.
  const top = entries.slice(0, 5);
  const mine = entries.find((entry) => entry.participantId === you);
  const includeMine = mine !== undefined && !top.includes(mine);

  return (
    <div className={styles.panel}>
      <ol className={styles.scoreList}>
        {top.map((entry) => (
          <ScoreRow key={entry.participantId} entry={entry} isYou={entry.participantId === you} />
        ))}

        {includeMine && (
          <>
            <li className={styles.scoreGap} aria-hidden="true">
              ⋯
            </li>
            <ScoreRow entry={mine} isYou />
          </>
        )}
      </ol>

      <button type="button" className={styles.panelClose} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function ScoreRow({ entry, isYou }: { entry: LeaderboardEntry; isYou: boolean }) {
  return (
    <li
      className={styles.scoreRow}
      data-you={isYou}
      data-rank={entry.rank <= 3 ? entry.rank : undefined}
    >
      <span className={styles.scoreRank}>{entry.rank}</span>
      <span className={styles.scoreName}>
        {entry.displayName}
        {isYou && <span className={styles.youTag}>you</span>}
      </span>
      <span className={styles.scoreValue}>{entry.score.toLocaleString()}</span>
    </li>
  );
}
