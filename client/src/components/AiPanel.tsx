import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { motion } from 'motion/react';
import { Sparkles, X, Loader2, Wand2, FileText, Upload, Check } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '../lib/api';
import styles from './AiPanel.module.css';

/**
 * Deck generation.
 *
 * The form is deliberately short: a topic is enough to get something useful,
 * and every other field has a sensible default. An author who wants control
 * has the editor; an author opening this wants a starting point fast.
 */

type Style = 'mixed' | 'quiz' | 'discussion' | 'feedback';

const STYLES: { value: Style; label: string; hint: string }[] = [
  { value: 'mixed', label: 'Mixed', hint: 'A bit of everything' },
  { value: 'quiz', label: 'Quiz', hint: 'Questions with right answers' },
  { value: 'discussion', label: 'Discussion', hint: 'Open questions and word clouds' },
  { value: 'feedback', label: 'Feedback', hint: 'Ratings and scales' },
];

export function AiPanel({
  open,
  onOpenChange,
  deckId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, slides are added to this deck rather than a new one. */
  deckId?: string;
  onDone: (deckId: string) => void;
}) {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [slideCount, setSlideCount] = useState(6);
  const [style, setStyle] = useState<Style>('mixed');
  const [busy, setBusy] = useState(false);

  // The extracted text, not the file. The server parses and discards; this
  // holds what it read back, so the author can see what the AI will work
  // from before spending a request on it.
  const [source, setSource] = useState<{
    filename: string;
    text: string;
    characters: number;
    truncated: boolean;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const readFile = async (file: File) => {
    setReading(true);
    try {
      const result = await api.readDocument(file);
      setSource({
        filename: result.filename,
        text: result.text,
        characters: result.characters,
        truncated: result.truncated,
      });

      if (result.truncated) {
        toast.warning('That document is long', {
          description: 'The first part was used. Split it if the rest matters.',
        });
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That file could not be read.');
    } finally {
      setReading(false);
    }
  };

  // A document is subject enough on its own; a topic is only required when
  // there is nothing else to work from.
  const ready = source !== null || topic.trim().length >= 3;

  const generate = async () => {
    if (!ready || busy) return;

    setBusy(true);
    try {
      const result = await api.generateDeck({
        topic: topic.trim(),
        slideCount,
        audience: audience.trim() || undefined,
        style,
        deckId,
        sourceText: source?.text,
        sourceName: source?.filename,
      });

      toast.success(`${String(result.deck.slides.length)} slides ready`, {
        description: `Written by ${result.provider}`,
      });

      onOpenChange(false);
      setTopic('');
      setSource(null);
      onDone(result.deck.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The AI could not be reached.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <span className={styles.mark} aria-hidden="true">
                <Sparkles size={17} />
              </span>
              <div>
                <Dialog.Title className={styles.title}>
                  {deckId ? 'Add slides with AI' : 'Build a deck with AI'}
                </Dialog.Title>
                <p className={styles.subtitle}>Describe the session. Edit anything afterwards.</p>
              </div>
            </div>
            <Dialog.Close className={styles.close} aria-label="Close">
              <X size={18} />
            </Dialog.Close>
          </header>

          <div className={styles.body}>
            {/* The document comes first: when there is one it is the subject,
                and the fields below become refinements of it. */}
            <div className={styles.field}>
              <span className={styles.label}>
                Build from a document <span className={styles.optional}>optional</span>
              </span>

              {source ? (
                <div className={styles.sourceCard}>
                  <span className={styles.sourceIcon} aria-hidden="true">
                    <Check size={16} />
                  </span>
                  <span className={styles.sourceText}>
                    <span className={styles.sourceName}>{source.filename}</span>
                    <span className={styles.sourceMeta}>
                      {source.characters.toLocaleString()} characters read
                      {source.truncated ? ' (shortened)' : ''}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={styles.sourceRemove}
                    onClick={() => {
                      setSource(null);
                    }}
                    aria-label="Remove document"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <label
                  className={styles.dropZone}
                  data-dragging={dragging}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => {
                    setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const file = e.dataTransfer.files[0];
                    if (file) void readFile(file);
                  }}
                >
                  <input
                    type="file"
                    className={styles.fileInput}
                    accept=".pdf,.docx,.txt,.md"
                    disabled={reading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readFile(file);
                      // Cleared, so choosing the same file twice still fires.
                      e.target.value = '';
                    }}
                  />

                  {reading ? (
                    <>
                      <Loader2 size={20} className={styles.spin} />
                      <span className={styles.dropTitle}>Reading the document...</span>
                    </>
                  ) : (
                    <>
                      <Upload size={20} className={styles.dropIcon} />
                      <span className={styles.dropTitle}>Drop a file, or click to choose</span>
                      <span className={styles.dropHint}>PDF, Word, Markdown or text</span>
                    </>
                  )}
                </label>
              )}
            </div>

            <label className={styles.field}>
              <span className={styles.label}>
                {source ? 'Anything to add?' : 'What is it about?'}
                {source ? <span className={styles.optional}> optional</span> : null}
              </span>
              <textarea
                className={styles.textarea}
                value={topic}
                rows={2}
                maxLength={300}
                autoFocus
                placeholder={
                  source
                    ? 'Focus on the second half, and keep it light'
                    : 'A team retrospective on our last sprint'
                }
                onChange={(e) => {
                  setTopic(e.target.value);
                }}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline, as people expect.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void generate();
                  }
                }}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>
                Who is in the room? <span className={styles.optional}>optional</span>
              </span>
              <input
                className={styles.input}
                value={audience}
                maxLength={120}
                placeholder="Engineers, mixed experience"
                onChange={(e) => {
                  setAudience(e.target.value);
                }}
              />
            </label>

            <div className={styles.field}>
              <span className={styles.label}>Shape of the session</span>
              <div className={styles.styles}>
                {STYLES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.styleCard}
                    data-active={style === option.value}
                    onClick={() => {
                      setStyle(option.value);
                    }}
                  >
                    <span className={styles.styleLabel}>{option.label}</span>
                    <span className={styles.styleHint}>{option.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className={styles.field}>
              <span className={styles.label}>How many slides — {slideCount}</span>
              <input
                type="range"
                className={styles.range}
                min={1}
                max={15}
                value={slideCount}
                onChange={(e) => {
                  setSlideCount(Number(e.target.value));
                }}
              />
            </div>
          </div>

          <footer className={styles.footer}>
            <button
              type="button"
              className={styles.generate}
              disabled={!ready || busy}
              onClick={() => {
                void generate();
              }}
            >
              {busy ? (
                <>
                  <Loader2 size={17} className={styles.spin} />
                  Writing your slides…
                </>
              ) : (
                <>
                  {source ? <FileText size={17} /> : <Wand2 size={17} />}
                  {deckId ? 'Add slides' : 'Create deck'}
                </>
              )}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ------------------------------------------------------------------ */
/* Availability                                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether any AI provider is configured.
 *
 * Checked once on mount so the AI controls are hidden rather than offered
 * and then failing — a dead button is worse than no button.
 */
export function useAiAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void api
      .aiStatus()
      .then((status) => {
        if (!cancelled) setAvailable(status.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

/* ------------------------------------------------------------------ */
/* Improve one slide                                                   */
/* ------------------------------------------------------------------ */

/** Suggests better wording for the slide being edited. */
export function ImproveButton({
  deckId,
  slideId,
  onPick,
}: {
  deckId: string;
  slideId: string;
  onPick: (prompt: string, options?: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<{ prompts: string[]; options?: string[] } | null>(
    null,
  );

  const ask = async () => {
    setBusy(true);
    try {
      const result = await api.improveSlide(deckId, slideId);
      setSuggestions({ prompts: result.prompts, options: result.options });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'The AI could not be reached.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.improve}>
      <button
        type="button"
        className={styles.improveButton}
        disabled={busy}
        onClick={() => {
          void ask();
        }}
      >
        {busy ? <Loader2 size={14} className={styles.spin} /> : <Sparkles size={14} />}
        {busy ? 'Thinking…' : 'Improve with AI'}
      </button>

      {suggestions && (
        <motion.div
          className={styles.suggestions}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          style={{ overflow: 'hidden' }}
        >
          {suggestions.prompts.map((prompt, i) => (
            <button
              key={i}
              type="button"
              className={styles.suggestion}
              onClick={() => {
                onPick(prompt, suggestions.options);
                setSuggestions(null);
              }}
            >
              {prompt}
            </button>
          ))}
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => {
              setSuggestions(null);
            }}
          >
            Keep what I have
          </button>
        </motion.div>
      )}
    </div>
  );
}
