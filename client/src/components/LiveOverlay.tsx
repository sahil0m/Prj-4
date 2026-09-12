import { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquare, X, Check } from 'lucide-react';
import { usePresenter } from '../lib/presenter-store';
import styles from './LiveOverlay.module.css';

/**
 * What the room does, other than answering.
 *
 * Reactions float up over the slide and disappear; questions collect in a
 * panel the presenter opens when they choose. Both are deliberately out of
 * the way — a question arriving must never cover the results a room is
 * reading, and a burst of applause must not obscure the slide.
 */

const GLYPHS: Record<string, string> = {
  clap: '👏',
  heart: '❤️',
  laugh: '😂',
  wow: '😮',
  thumbsUp: '👍',
};

/* ------------------------------------------------------------------ */
/* Reactions                                                           */
/* ------------------------------------------------------------------ */

export function ReactionLayer() {
  const reactions = usePresenter((s) => s.reactions);

  return (
    <div className={styles.reactionLayer} aria-hidden="true">
      <AnimatePresence>
        {reactions.map((reaction) => (
          <FloatingReaction key={reaction.id} id={reaction.id} emoji={reaction.emoji} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function FloatingReaction({ id, emoji }: { id: number; emoji: string }) {
  const dismiss = usePresenter((s) => s.dismissReaction);

  useEffect(() => {
    // Removed after the animation rather than left in the list: a long
    // session would otherwise accumulate thousands of finished elements.
    const timer = setTimeout(() => {
      dismiss(id);
    }, 3200);

    return () => {
      clearTimeout(timer);
    };
  }, [id, dismiss]);

  // A little horizontal spread, so twenty claps do not stack in one column.
  const drift = ((id * 37) % 60) - 30;
  const start = ((id * 61) % 70) + 15;

  return (
    <motion.span
      className={styles.reaction}
      initial={{ opacity: 0, y: 0, scale: 0.5, x: 0 }}
      animate={{ opacity: [0, 1, 1, 0], y: -260, scale: 1, x: drift }}
      exit={{ opacity: 0 }}
      transition={{ duration: 3, ease: 'easeOut', times: [0, 0.12, 0.7, 1] }}
      style={{ left: `${String(start)}%` }}
    >
      {GLYPHS[emoji] ?? '👏'}
    </motion.span>
  );
}

/* ------------------------------------------------------------------ */
/* Questions                                                           */
/* ------------------------------------------------------------------ */

/** A count that opens the question panel; hidden until something arrives. */
export function QuestionButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const questions = usePresenter((s) => s.questions);
  const waiting = questions.filter((q) => !q.answered).length;

  if (questions.length === 0) return null;

  return (
    <button
      type="button"
      className={styles.questionButton}
      data-active={open}
      onClick={onToggle}
      title="Questions from the audience"
    >
      <MessageSquare size={18} />
      <span className={styles.questionLabel}>Questions</span>
      {waiting > 0 && <span className={styles.badge}>{waiting}</span>}
    </button>
  );
}

/**
 * The queue of questions.
 *
 * A side panel rather than a modal: a presenter reads a question while the
 * results stay on screen, and closing it should not feel like leaving the
 * session.
 */
export function QuestionPanel({ onClose }: { onClose: () => void }) {
  const questions = usePresenter((s) => s.questions);
  const markAnswered = usePresenter((s) => s.markAnswered);

  const waiting = questions.filter((q) => !q.answered);
  const done = questions.filter((q) => q.answered);

  return (
    <motion.aside
      className={styles.panel}
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
    >
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>
          Questions
          {waiting.length > 0 && <span className={styles.panelCount}>{waiting.length}</span>}
        </h2>
        <button
          type="button"
          className={styles.panelClose}
          onClick={onClose}
          aria-label="Close questions"
        >
          <X size={18} />
        </button>
      </header>

      <div className={styles.panelBody}>
        {waiting.length === 0 && done.length === 0 && (
          <p className={styles.panelEmpty}>Nothing asked yet.</p>
        )}

        {waiting.map((question) => (
          <motion.article
            key={question.id}
            className={styles.question}
            layout
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <p className={styles.questionText}>{question.text}</p>
            <div className={styles.questionFoot}>
              <span className={styles.questionAuthor}>{question.displayName || 'Anonymous'}</span>
              <button
                type="button"
                className={styles.answered}
                onClick={() => {
                  markAnswered(question.id);
                }}
              >
                <Check size={13} />
                Answered
              </button>
            </div>
          </motion.article>
        ))}

        {done.length > 0 && (
          <>
            <p className={styles.doneLabel}>Answered</p>
            {done.map((question) => (
              <article key={question.id} className={`${styles.question} ${styles.questionDone}`}>
                <p className={styles.questionText}>{question.text}</p>
                <span className={styles.questionAuthor}>{question.displayName || 'Anonymous'}</span>
              </article>
            ))}
          </>
        )}
      </div>
    </motion.aside>
  );
}
