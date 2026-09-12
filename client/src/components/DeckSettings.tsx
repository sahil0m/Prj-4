import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Palette, Users, Shield, Copy, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type Deck } from '../lib/api';
import { Toggle, Choice, InfoHint } from './Controls';
import styles from './DeckSettings.module.css';

/**
 * How a deck behaves when it is presented.
 *
 * These settings existed on the server from the start with no way to reach
 * them. They are grouped by when someone thinks about them: how it looks,
 * how the room takes part, and what the deck itself is — rather than in the
 * order the schema happens to declare them.
 */

const THEMES: { value: string; label: string; accent: string; canvas: string }[] = [
  { value: 'midnight', label: 'Midnight', accent: '#7c5cf6', canvas: '#0b0d17' },
  { value: 'aurora', label: 'Aurora', accent: '#22d3ee', canvas: '#071318' },
  { value: 'ember', label: 'Ember', accent: '#f97316', canvas: '#1a0e08' },
  { value: 'forest', label: 'Forest', accent: '#4ade80', canvas: '#07160f' },
  { value: 'rose', label: 'Rose', accent: '#f472b6', canvas: '#180b12' },
  { value: 'slate', label: 'Slate', accent: '#94a3b8', canvas: '#0f1419' },
];

export function DeckSettings({
  open,
  onOpenChange,
  deck,
  onSave,
  onDuplicate,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deck: Deck;
  onSave: (patch: { theme?: Record<string, unknown>; settings?: Record<string, unknown> }) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const theme = deck.theme;
  const settings = deck.settings;

  const [confirmDelete, setConfirmDelete] = useState(false);

  const setting = (key: string, fallback: boolean): boolean =>
    typeof settings[key] === 'boolean' ? settings[key] : fallback;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>Deck settings</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </header>

          <div className={styles.body}>
            {/* ---------------- theme ---------------- */}
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>
                <Palette size={15} />
                How it looks
              </h3>

              <div className={styles.themes}>
                {THEMES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.theme}
                    data-active={theme.preset === option.value}
                    onClick={() => {
                      onSave({ theme: { preset: option.value, accent: option.accent } });
                    }}
                  >
                    <span
                      className={styles.themeSwatch}
                      style={{
                        background: `linear-gradient(135deg, ${option.accent}, ${option.canvas})`,
                      }}
                      aria-hidden="true"
                    />
                    <span className={styles.themeLabel}>{option.label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* ---------------- participation ---------------- */}
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>
                <Users size={15} />
                How the room takes part
              </h3>

              <Choice
                id="deck-mode"
                label="Pacing"
                value={typeof settings.mode === 'string' ? settings.mode : 'presenter_paced'}
                options={[
                  { value: 'presenter_paced', label: 'Everyone follows the presenter' },
                  { value: 'audience_paced', label: 'People move at their own speed' },
                ]}
                onChange={(mode) => {
                  onSave({ settings: { mode } });
                }}
              />

              <div className={styles.toggleWithHint}>
                <Toggle
                  id="deck-names"
                  label="Ask for names"
                  hint="Quizzes always ask, whatever this says."
                  checked={setting('collectNames', false)}
                  onChange={(collectNames) => {
                    onSave({ settings: { collectNames } });
                  }}
                />
              </div>

              <Toggle
                id="deck-results"
                label="Show results on phones"
                hint="People see the chart as well as the presenter."
                checked={setting('showResultsToParticipants', false)}
                onChange={(showResultsToParticipants) => {
                  onSave({ settings: { showResultsToParticipants } });
                }}
              />

              <Toggle
                id="deck-reactions"
                label="Allow reactions"
                checked={setting('reactions', true)}
                onChange={(reactions) => {
                  onSave({ settings: { reactions } });
                }}
              />

              <Toggle
                id="deck-chat"
                label="Allow questions"
                hint="People can send questions you answer when you choose."
                checked={setting('chat', false)}
                onChange={(chat) => {
                  onSave({ settings: { chat } });
                }}
              />
            </section>

            {/* ---------------- integrity ---------------- */}
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>
                <Shield size={15} />
                Keeping it clean
              </h3>

              <div className={styles.toggleWithHint}>
                <Toggle
                  id="deck-profanity"
                  label="Filter rude words"
                  hint="Blocked before they reach the projector."
                  checked={setting('profanityFilter', true)}
                  onChange={(profanityFilter) => {
                    onSave({ settings: { profanityFilter } });
                  }}
                />
              </div>

              <div className={styles.toggleRow}>
                <Toggle
                  id="deck-one-answer"
                  label="One answer per device"
                  checked={setting('oneAnswerPerDevice', true)}
                  onChange={(oneAnswerPerDevice) => {
                    onSave({ settings: { oneAnswerPerDevice } });
                  }}
                />
                <InfoHint text="Someone who refreshes rejoins as the same person rather than voting twice. Turning this off lets one device answer repeatedly." />
              </div>
            </section>

            {/* ---------------- the deck itself ---------------- */}
            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>This deck</h3>

              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={onDuplicate}>
                  <Copy size={15} />
                  Duplicate
                </button>

                <button
                  type="button"
                  className={`${styles.action} ${styles.actionDanger}`}
                  onClick={() => {
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 size={15} />
                  Delete
                </button>
              </div>

              {confirmDelete && (
                <div className={styles.confirm}>
                  <p className={styles.confirmText}>
                    Delete this deck? Past sessions and their results are kept.
                  </p>
                  <div className={styles.confirmActions}>
                    <button
                      type="button"
                      className={styles.action}
                      onClick={() => {
                        setConfirmDelete(false);
                      }}
                    >
                      Keep it
                    </button>
                    <button type="button" className={styles.confirmDelete} onClick={onDelete}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Saving                                                              */
/* ------------------------------------------------------------------ */

/**
 * Applies a settings change and reports failure.
 *
 * Kept out of the component so the dialog stays about presentation, and so
 * the editor can use the same path for a change made anywhere else.
 */
export function useDeckSettings(deckId: string, onChanged: () => void) {
  const [saving, setSaving] = useState(false);

  const save = (patch: { theme?: Record<string, unknown>; settings?: Record<string, unknown> }) => {
    setSaving(true);

    void api
      .updateDeck(deckId, patch)
      .then(() => {
        onChanged();
      })
      .catch((err: unknown) => {
        toast.error(err instanceof ApiError ? err.message : 'That could not be saved.');
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return { save, saving };
}

/** A spinner for the header while a settings change is in flight. */
export function SavingDot({ saving }: { saving: boolean }) {
  if (!saving) return null;
  return <Loader2 size={14} className={styles.spin} />;
}
