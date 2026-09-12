import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Users,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  X,
  Maximize2,
  Minimize2,
  WifiOff,
} from 'lucide-react';
import { definitionFor, type SlideKind } from '@pulse/shared';
import { usePresenter } from '../lib/presenter-store';
import { Results } from '../components/Results';
import { Splash } from '../components/Splash';
import styles from './Presenter.module.css';

/**
 * The screen the room looks at.
 *
 * Everything is sized in viewport units, because this is shown on anything
 * from a laptop to a projector to a wall-sized display, and the same layout
 * has to be legible from the back row of all of them.
 */
export function Presenter() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();

  const session = usePresenter((s) => s.session);
  const snapshot = usePresenter((s) => s.snapshot);
  const state = usePresenter((s) => s.state);
  const results = usePresenter((s) => s.results);
  const connected = usePresenter((s) => s.connected);
  const loading = usePresenter((s) => s.loading);
  const error = usePresenter((s) => s.error);

  const open = usePresenter((s) => s.open);
  const close = usePresenter((s) => s.close);
  const next = usePresenter((s) => s.next);
  const previous = usePresenter((s) => s.previous);
  const setParticipation = usePresenter((s) => s.setParticipation);
  const setResultsVisible = usePresenter((s) => s.setResultsVisible);
  const end = usePresenter((s) => s.end);

  const [fullscreen, setFullscreen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (sessionId) void open(sessionId);
    return () => {
      close();
    };
  }, [sessionId, open, close]);

  /* ---------------- keyboard ---------------- */

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      // Space and arrows are what a presenter remote sends, so the same keys
      // that drive PowerPoint drive this.
      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          event.preventDefault();
          next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          previous();
          break;
        case 'f':
          void toggleFullscreen();
          break;
        default:
          break;
      }
    },
    [next, previous],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onKey]);

  useEffect(() => {
    const sync = () => {
      setFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
    };
  }, []);

  if (loading) return <Splash message="Starting the session" />;

  if (error !== null || !session || !snapshot) {
    return (
      <div className={styles.errorPage}>
        <h1 className={styles.errorTitle}>This session could not be opened</h1>
        <p className={styles.errorBody}>{error ?? 'Something went wrong.'}</p>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => {
            void navigate('/');
          }}
        >
          Back to your decks
        </button>
      </div>
    );
  }

  const slides = snapshot.slides;
  const index = slides.findIndex((s) => s.id === state?.currentSlideId);
  const slide = slides[index] ?? slides[0];
  const answerable = slide ? definitionFor(slide.kind as SlideKind).answerable : false;

  const joinHost = window.location.hostname;
  const joinUrl = `${joinHost}:5174`;

  return (
    <div className={styles.page} data-fullscreen={fullscreen}>
      {/* ---------------- top bar ---------------- */}
      <header className={styles.top}>
        <div className={styles.joinInfo}>
          <span className={styles.joinLabel}>Join at</span>
          <span className={styles.joinUrl}>{joinUrl}</span>
          <span className={styles.joinCodeBox}>{formatCode(session.joinCode)}</span>
        </div>

        <div className={styles.topRight}>
          {!connected && (
            <span className={styles.offline}>
              <WifiOff size={15} />
              Reconnecting
            </span>
          )}

          <span className={styles.participants}>
            <Users size={17} />
            {state?.participantCount ?? 0}
          </span>
        </div>
      </header>

      {/* ---------------- stage ---------------- */}
      <main className={styles.stage}>
        <AnimatePresence mode="wait">
          <motion.div
            key={slide?.id ?? 'none'}
            className={styles.slide}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0.1, 1] }}
          >
            <h1 className={styles.prompt}>{promptOf(slide)}</h1>
            {subtitleOf(slide) !== '' && <p className={styles.subtitle}>{subtitleOf(slide)}</p>}

            <div className={styles.results}>
              {!answerable ? (
                <ContentSlide kind={slide?.kind as SlideKind} config={slide?.config ?? {}} />
              ) : state?.resultsVisible === false ? (
                <div className={styles.hidden}>
                  <EyeOff size={34} />
                  <p>Results hidden</p>
                  <span>{results?.count ?? 0} answers so far</span>
                </div>
              ) : (
                <Results results={results} />
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ---------------- controls ---------------- */}
      <footer className={styles.controls}>
        <div className={styles.controlGroup}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={previous}
            disabled={index <= 0}
            aria-label="Previous slide"
          >
            <ChevronLeft size={20} />
          </button>

          <span className={styles.position}>
            {index + 1} / {slides.length}
          </span>

          <button
            type="button"
            className={styles.controlButton}
            onClick={next}
            disabled={index >= slides.length - 1}
            aria-label="Next slide"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        <div className={styles.controlGroup}>
          {answerable && (
            <>
              <button
                type="button"
                className={styles.controlButton}
                data-active={state?.participationOpen === true}
                onClick={() => {
                  setParticipation(state?.participationOpen !== true);
                }}
                title={state?.participationOpen === true ? 'Close voting' : 'Open voting'}
              >
                {state?.participationOpen === true ? <Unlock size={18} /> : <Lock size={18} />}
                <span className={styles.controlLabel}>
                  {state?.participationOpen === true ? 'Open' : 'Closed'}
                </span>
              </button>

              <button
                type="button"
                className={styles.controlButton}
                onClick={() => {
                  setResultsVisible(state?.resultsVisible !== true);
                }}
                title={state?.resultsVisible === true ? 'Hide results' : 'Show results'}
              >
                {state?.resultsVisible === true ? <Eye size={18} /> : <EyeOff size={18} />}
                <span className={styles.controlLabel}>
                  {state?.resultsVisible === true ? 'Showing' : 'Hidden'}
                </span>
              </button>
            </>
          )}

          <button
            type="button"
            className={styles.controlButton}
            onClick={() => {
              void toggleFullscreen();
            }}
            title="Fullscreen (F)"
          >
            {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>

          <button
            type="button"
            className={`${styles.controlButton} ${styles.endButton}`}
            onClick={() => {
              setConfirmEnd(true);
            }}
          >
            <X size={18} />
            <span className={styles.controlLabel}>End</span>
          </button>
        </div>
      </footer>

      {/* ---------------- end confirmation ---------------- */}
      {confirmEnd && (
        <div className={styles.confirmOverlay} role="dialog" aria-modal="true">
          <div className={styles.confirmBox}>
            <h2 className={styles.confirmTitle}>End this session?</h2>
            <p className={styles.confirmBody}>
              Everyone will be disconnected and the join code stops working. The results are kept.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() => {
                  setConfirmEnd(false);
                }}
              >
                Keep going
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => {
                  void (async () => {
                    await end();
                    await navigate('/');
                  })();
                }}
              >
                End session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Content slides                                                      */
/* ------------------------------------------------------------------ */

/** A slide the audience watches rather than answers. */
function ContentSlide({ kind, config }: { kind: SlideKind; config: Record<string, unknown> }) {
  const text = (key: string): string => (typeof config[key] === 'string' ? config[key] : '');

  switch (kind) {
    case 'big_number':
      return (
        <div className={styles.bigNumber}>
          <span className={styles.bigNumberValue}>{text('value') || '—'}</span>
          {text('caption') !== '' && (
            <span className={styles.bigNumberCaption}>{text('caption')}</span>
          )}
        </div>
      );

    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <p>{text('quote') || text('text')}</p>
          {text('attribution') !== '' && <cite>— {text('attribution')}</cite>}
        </blockquote>
      );

    case 'bullets': {
      const items = Array.isArray(config.items)
        ? (config.items as { id: string; label: string }[])
        : [];
      return (
        <ul className={styles.bullets}>
          {items.map((item) => (
            <li key={item.id}>{item.label}</li>
          ))}
        </ul>
      );
    }

    case 'image':
      return text('imageUrl') === '' ? (
        <p className={styles.contentPlaceholder}>No image set</p>
      ) : (
        <img src={text('imageUrl')} alt={text('alt')} className={styles.contentImage} />
      );

    case 'paragraph':
    case 'instructions':
      return <p className={styles.paragraph}>{text('body') || text('text')}</p>;

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    // Refused by the browser, usually because it was not user-initiated.
  }
}

/** 123456 -> 123 456, which is easier to read aloud and to copy. */
function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function promptOf(slide: { config: Record<string, unknown> } | undefined): string {
  const prompt = slide?.config.prompt;
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : '';
}

function subtitleOf(slide: { config: Record<string, unknown> } | undefined): string {
  const subtitle = slide?.config.subtitle;
  return typeof subtitle === 'string' ? subtitle : '';
}
