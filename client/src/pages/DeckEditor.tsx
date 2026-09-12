import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  Plus,
  Copy,
  Trash2,
  MoreVertical,
  ChevronUp,
  ChevronDown,
  Check,
  Loader2,
  AlertCircle,
  Presentation,
} from 'lucide-react';
import { definitionFor, type SlideKind } from '@pulse/shared';
import { useDeck, useSelectedSlide } from '../lib/deck-store';
import { SlidePicker } from '../components/SlidePicker';
import { SlideForm } from '../components/SlideForm';
import { SlideIcon } from '../components/SlideIcon';
import { Splash } from '../components/Splash';
import styles from './DeckEditor.module.css';

/**
 * The deck editor: slide list on the left, preview in the middle, settings
 * on the right. Edits save themselves, so there is no save button to forget.
 */
export function DeckEditor() {
  const { deckId } = useParams<{ deckId: string }>();
  const navigate = useNavigate();

  const deck = useDeck((s) => s.deck);
  const loading = useDeck((s) => s.loading);
  const loadError = useDeck((s) => s.loadError);
  const selectedId = useDeck((s) => s.selectedSlideId);
  const load = useDeck((s) => s.load);
  const close = useDeck((s) => s.close);
  const select = useDeck((s) => s.select);
  const addSlide = useDeck((s) => s.addSlide);
  const rename = useDeck((s) => s.rename);
  const updateSlideConfig = useDeck((s) => s.updateSlideConfig);
  const deleteSlide = useDeck((s) => s.deleteSlide);
  const duplicateSlide = useDeck((s) => s.duplicateSlide);
  const moveSlide = useDeck((s) => s.moveSlide);

  const slide = useSelectedSlide();
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (deckId) void load(deckId);
    return () => {
      close();
    };
  }, [deckId, load, close]);

  if (loading) return <Splash message="Opening deck" />;

  if (loadError) {
    return (
      <div className={styles.errorPage}>
        <AlertCircle size={30} className={styles.errorIcon} />
        <h1 className={styles.errorTitle}>This deck could not be opened</h1>
        <p className={styles.errorBody}>{loadError}</p>
        <button
          type="button"
          className={styles.backButton}
          onClick={() => {
            void navigate('/');
          }}
        >
          Back to your decks
        </button>
      </div>
    );
  }

  if (!deck) return null;

  const index = deck.slides.findIndex((s) => s.id === selectedId);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => {
              void navigate('/');
            }}
            aria-label="Back to your decks"
          >
            <ArrowLeft size={18} />
          </button>

          <input
            className={styles.titleInput}
            value={deck.title}
            onChange={(e) => {
              rename(e.target.value);
            }}
            aria-label="Deck title"
            placeholder="Untitled deck"
          />
        </div>

        <div className={styles.headerRight}>
          <SaveIndicator />
          <button type="button" className={styles.presentButton} disabled title="Coming next">
            <Presentation size={16} />
            Present
          </button>
        </div>
      </header>

      <div className={styles.body}>
        {/* ---------------- slide list ---------------- */}
        <aside className={styles.rail}>
          <div className={styles.railHead}>
            <span className={styles.railTitle}>
              {deck.slides.length} {deck.slides.length === 1 ? 'slide' : 'slides'}
            </span>
          </div>

          <ol className={styles.slideList}>
            {deck.slides.map((item, i) => {
              const definition = definitionFor(item.kind);
              const prompt = (item.config as { prompt?: string }).prompt;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.slideItem}
                    data-selected={item.id === selectedId}
                    onClick={() => {
                      select(item.id);
                    }}
                  >
                    <span className={styles.slideNumber}>{i + 1}</span>
                    <span className={styles.slideIcon} aria-hidden="true">
                      <SlideIcon name={definition.icon} size={14} />
                    </span>
                    <span className={styles.slideText}>
                      <span className={styles.slidePrompt}>
                        {prompt?.trim() ? prompt : definition.label}
                      </span>
                      <span className={styles.slideKind}>{definition.label}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <button
            type="button"
            className={styles.addSlide}
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            <Plus size={16} />
            Add slide
          </button>
        </aside>

        {/* ---------------- preview ---------------- */}
        <main className={styles.stage}>
          {slide ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={slide.id}
                className={styles.canvas}
                initial={{ opacity: 0, scale: 0.985 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.985 }}
                transition={{ duration: 0.2 }}
              >
                <SlidePreview kind={slide.kind} config={slide.config} />
              </motion.div>
            </AnimatePresence>
          ) : (
            <div className={styles.emptyStage}>
              <p className={styles.emptyStageTitle}>This deck has no slides yet</p>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  setPickerOpen(true);
                }}
              >
                <Plus size={16} />
                Add your first slide
              </button>
            </div>
          )}
        </main>

        {/* ---------------- settings ---------------- */}
        <aside className={styles.panel}>
          {slide ? (
            <>
              <div className={styles.panelActions}>
                <button
                  type="button"
                  className={styles.panelAction}
                  onClick={() => {
                    void moveSlide(slide.id, index - 1);
                  }}
                  disabled={index <= 0}
                  aria-label="Move slide up"
                >
                  <ChevronUp size={15} />
                </button>
                <button
                  type="button"
                  className={styles.panelAction}
                  onClick={() => {
                    void moveSlide(slide.id, index + 1);
                  }}
                  disabled={index >= deck.slides.length - 1}
                  aria-label="Move slide down"
                >
                  <ChevronDown size={15} />
                </button>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button type="button" className={styles.panelAction} aria-label="More actions">
                      <MoreVertical size={15} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className={styles.menu} sideOffset={6} align="end">
                      <DropdownMenu.Item
                        className={styles.menuItem}
                        onSelect={() => {
                          void duplicateSlide(slide.id);
                        }}
                      >
                        <Copy size={14} />
                        Duplicate slide
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        className={`${styles.menuItem} ${styles.menuItemDanger}`}
                        onSelect={() => {
                          void deleteSlide(slide.id);
                        }}
                      >
                        <Trash2 size={14} />
                        Delete slide
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              <div className={styles.panelScroll}>
                <SlideForm
                  kind={slide.kind}
                  config={slide.config}
                  onChange={(patch) => {
                    updateSlideConfig(slide.id, patch);
                  }}
                />
              </div>
            </>
          ) : (
            <p className={styles.panelEmpty}>Add a slide to start editing.</p>
          )}
        </aside>
      </div>

      <SlidePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(kind: SlideKind) => {
          void addSlide(kind, selectedId ?? undefined);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Save indicator                                                      */
/* ------------------------------------------------------------------ */

function SaveIndicator() {
  const saveState = useDeck((s) => s.saveState);
  const saveError = useDeck((s) => s.saveError);

  if (saveState === 'idle') return null;

  if (saveState === 'error') {
    return (
      <span className={styles.saveState} data-state="error" title={saveError ?? undefined}>
        <AlertCircle size={14} />
        Not saved
      </span>
    );
  }

  if (saveState === 'saving') {
    return (
      <span className={styles.saveState} data-state="saving">
        <Loader2 size={14} className={styles.spin} />
        Saving
      </span>
    );
  }

  return (
    <span className={styles.saveState} data-state="saved">
      <Check size={14} />
      Saved
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * A rough picture of the slide as the room will see it.
 *
 * This is deliberately simple until the presenter view lands: it shows the
 * words and the shape of the answer, which is what an author checks while
 * writing. Live results come with the session engine.
 */
function SlidePreview({ kind, config }: { kind: SlideKind; config: Record<string, unknown> }) {
  const definition = definitionFor(kind);
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  const subtitle = typeof config.subtitle === 'string' ? config.subtitle : '';
  const options = Array.isArray(config.options)
    ? (config.options as { id: string; label: string; correct?: boolean }[])
    : [];

  return (
    <div className={styles.preview}>
      <p className={styles.previewPrompt} data-placeholder={prompt.trim() === ''}>
        {prompt.trim() === '' ? 'Your question goes here' : prompt}
      </p>
      {subtitle.trim() !== '' && <p className={styles.previewSubtitle}>{subtitle}</p>}

      {options.length > 0 ? (
        <ul className={styles.previewOptions}>
          {options.map((option, i) => (
            <li key={option.id} className={styles.previewOption}>
              <span className={styles.previewOptionKey}>{String.fromCharCode(65 + i)}</span>
              <span>{option.label.trim() === '' ? `Option ${String(i + 1)}` : option.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.previewPlaceholder}>
          <SlideIcon name={definition.icon} size={26} />
          <span>{definition.blurb}</span>
        </div>
      )}
    </div>
  );
}
