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
  Download,
  Sparkles,
  Loader2,
  Eye as EyeIcon,
  CheckCircle2,
  Check,
  Copy,
  QrCode as QrCodeIcon,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  definitionFor,
  type CountedItem,
  type ResultData,
  type SlideKind,
  type SlideResults,
} from '@pulse/shared';
import { applyTheme } from '@pulse/shared/theme';
import { usePresenter } from '../lib/presenter-store';
import { Results } from '../components/Results';
import { Leaderboard } from '../components/Leaderboard';
import { ReactionLayer, QuestionButton, QuestionPanel, QaStage } from '../components/LiveOverlay';
import { CompareSlide } from '../components/CompareSlide';
import { Countdown } from '../components/Countdown';
import { api, ApiError, type TextSummary } from '../lib/api';
import { useAiAvailable } from '../components/AiPanel';
import { toast } from 'sonner';
import { QrCode } from '../components/QrCode';
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
  const leaderboard = usePresenter((s) => s.leaderboard);
  const connected = usePresenter((s) => s.connected);
  const loading = usePresenter((s) => s.loading);
  const error = usePresenter((s) => s.error);

  const open = usePresenter((s) => s.open);
  const close = usePresenter((s) => s.close);
  const next = usePresenter((s) => s.next);
  const previous = usePresenter((s) => s.previous);
  const setParticipation = usePresenter((s) => s.setParticipation);
  const setResultsVisible = usePresenter((s) => s.setResultsVisible);
  const removeResponse = usePresenter((s) => s.removeResponse);
  const end = usePresenter((s) => s.end);

  const [fullscreen, setFullscreen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [summary, setSummary] = useState<{ data: TextSummary; slideId: string } | null>(null);
  const [summarising, setSummarising] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);

  /**
   * Which quiz slides have had their answer revealed.
   *
   * Revealing is its own decision, separate from closing the vote: a
   * presenter may close early and keep the room guessing, or reveal while
   * stragglers are still answering. Tying the two together meant the right
   * answer was only ever visible by accident.
   *
   * Held per slide, so going back to a revealed question does not hide it
   * again, and moving forward does not give the next one away.
   */
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  /*
   * Which address the room is told to open.
   *
   * A laptop on Wi-Fi and a phone hotspot at once has more than one, and
   * only one of them reaches any given phone. The server puts its best
   * guess first; this is the presenter's way to correct it without
   * restarting anything.
   */
  const [chosenAddress, setChosenAddress] = useState<string | null>(null);

  /*
   * Whether the join panel is being held open.
   *
   * It shows itself while the room is empty and steps aside once answers
   * arrive, which is right for the first minute and wrong for the rest of
   * the session: someone always walks in late, and a code in the top bar
   * is not something you can point a camera at. This is how a presenter
   * brings it back.
   */
  const [showJoin, setShowJoin] = useState(false);

  const aiAvailable = useAiAvailable();

  const download = (format: 'csv' | 'leaderboard' | 'statistics') => {
    if (!sessionId) return;
    // A plain navigation rather than fetch-and-blob: the response carries a
    // Content-Disposition header, so the browser saves it under the right
    // name and nothing has to be held in memory.
    window.open(`/api/sessions/${sessionId}/export?format=${format}`, '_blank');
  };

  useEffect(() => {
    if (sessionId) void open(sessionId);
    return () => {
      close();
    };
  }, [sessionId, open, close]);

  /*
   * The deck's own theme, applied to the page itself.
   *
   * On the root rather than this component's container, because the
   * background is painted on the body -- a deck with a light background set
   * on a container leaves a dark frame around the slide. Undone when the
   * presenter leaves, so the rest of the app keeps its own colours.
   *
   * Only the accent used to be applied at all, so a deck's background, font
   * and light mode were chosen in the editor and then ignored on the screen
   * the room looks at.
   */
  const deckTheme = session?.theme ?? null;

  useEffect(() => applyTheme(document.documentElement, deckTheme), [deckTheme]);

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

  // Decides which export the button offers: standings for a quiz deck, the
  // raw answers otherwise.
  const hasQuiz = slides.some((s) => definitionFor(s.kind as SlideKind).isQuiz);
  const isQuizSlide = slide ? definitionFor(slide.kind as SlideKind).isQuiz : false;

  // A summary belongs to one slide. Showing it after a slide change would
  // attribute one question's themes to another.
  const currentSummary = summary !== null && summary.slideId === slide?.id ? summary.data : null;

  /**
   * Groups a wall of open text into themes.
   *
   * The most useful thing the AI does here: two hundred free-text answers
   * are unreadable on a projector and a presenter cannot group them live.
   */
  const summarise = async () => {
    if (!sessionId || !slide || summarising) return;

    setSummarising(true);
    try {
      const result = await api.summarise(sessionId, slide.id);
      setSummary({ data: result.summary, slideId: slide.id });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That could not be summarised.');
    } finally {
      setSummarising(false);
    }
  };

  // The server tells us where the audience should go. The browser cannot:
  // this tab may be on localhost, which no other device can reach.
  const addresses = session.joinUrls.length > 0 ? session.joinUrls : [session.joinUrl];
  const address =
    chosenAddress && addresses.includes(chosenAddress)
      ? chosenAddress
      : (addresses[0] ?? session.joinUrl);
  const setAddress = setChosenAddress;

  return (
    <div className={styles.page} data-fullscreen={fullscreen}>
      {/* ---------------- top bar ---------------- */}
      <header className={styles.top}>
        <div className={styles.joinInfo}>
          <span className={styles.joinLabel}>Join at</span>
          <span className={styles.joinUrl}>{address.replace(/^https?:\/\//, '')}</span>
          <span className={styles.joinCodeBox}>{formatCode(session.joinCode)}</span>
        </div>

        {/* The deck's own mark, which was stored and never shown. Quiet
            and in the corner: it belongs to the room's host, not to the
            question being asked. */}
        {typeof deckTheme?.logoUrl === 'string' && deckTheme.logoUrl !== '' && (
          <img className={styles.logo} src={deckTheme.logoUrl} alt="" />
        )}

        <div className={styles.topRight}>
          {!connected && (
            <span className={styles.offline}>
              <WifiOff size={15} />
              Reconnecting
            </span>
          )}

          {/* Only while a clock is actually running; an empty ring on
              every slide would be furniture. */}
          <Countdown endsAt={state?.countdownEndsAt ?? null} />

          <span className={styles.participants}>
            <Users size={17} />
            {state?.participantCount ?? 0}
          </span>
        </div>
      </header>

      {/* ---------------- how to join ---------------- */}
      {/* Large while the room is empty, because that is when people need it;
          it steps aside once answers start arriving. */}
      <AnimatePresence>
        {((state?.participantCount ?? 0) === 0 || showJoin) && (
          <motion.aside
            className={styles.joinPanel}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.3 }}
          >
            <div className={styles.qrBox}>
              <QrCode value={`${address}/?code=${session.joinCode}`} size={168} />
            </div>
            <p className={styles.joinPanelHint}>Scan to join, or go to</p>
            <p className={styles.joinPanelUrl}>{address.replace(/^https?:\/\//, '')}</p>
            <p className={styles.joinPanelCode}>{formatCode(session.joinCode)}</p>

            <JoinAddressPicker addresses={session.joinUrls} value={address} onChange={setAddress} />

            {showJoin && (
              <button
                type="button"
                className={styles.joinPanelClose}
                onClick={() => {
                  setShowJoin(false);
                }}
              >
                Hide
              </button>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* ---------------- stage ---------------- */}
      <main className={styles.stage}>
        {/* Over the slide, but never intercepting a click. */}
        <ReactionLayer />

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
              {slide?.kind === 'leaderboard' ? (
                <Leaderboard entries={leaderboard} />
              ) : slide?.kind === 'qa' ? (
                /* The questions belong on the wall for this slide; the
                   side panel is for reading them during other slides. */
                <QaStage />
              ) : slide?.kind === 'compare' ? (
                <CompareSlide
                  sessionId={session.id}
                  slideIdA={stringOf(slide.config.slideIdA)}
                  slideIdB={stringOf(slide.config.slideIdB)}
                  labelA={stringOf(slide.config.labelA) || 'Before'}
                  labelB={stringOf(slide.config.labelB) || 'After'}
                />
              ) : currentSummary ? (
                <SummaryView
                  summary={currentSummary}
                  onClose={() => {
                    setSummary(null);
                  }}
                />
              ) : !answerable ? (
                <ContentSlide kind={slide?.kind as SlideKind} config={slide?.config ?? {}} />
              ) : state?.resultsVisible === false ? (
                <div className={styles.hidden}>
                  <EyeOff size={34} />
                  <p>Results hidden</p>
                  <span>{results?.count ?? 0} answers so far</span>
                </div>
              ) : (
                <>
                  <Results
                    results={results}
                    onRemove={removeResponse}
                    // A quiz only reveals which answer was right once the
                    // presenter says so; showing it while people are still
                    // answering would give the game away on the big screen.
                    revealCorrect={isQuizSlide && slide !== undefined && revealed.has(slide.id)}
                  />

                  {results && results.count > 0 && (
                    <ResultStats
                      results={results}
                      participantCount={state?.participantCount ?? 0}
                      revealed={slide !== undefined && revealed.has(slide.id)}
                    />
                  )}
                </>
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
          {/* Its own control, because revealing and closing the vote are
              different decisions a presenter makes at different moments. */}
          {isQuizSlide && slide && (
            <button
              type="button"
              className={styles.controlButton}
              data-active={revealed.has(slide.id)}
              onClick={() => {
                setRevealed((current) => {
                  const next = new Set(current);
                  if (next.has(slide.id)) next.delete(slide.id);
                  else next.add(slide.id);
                  return next;
                });
              }}
              title={revealed.has(slide.id) ? 'Hide the answer' : 'Show the correct answer'}
            >
              {revealed.has(slide.id) ? <CheckCircle2 size={18} /> : <EyeIcon size={18} />}
              <span className={styles.controlLabel}>
                {revealed.has(slide.id) ? 'Revealed' : 'Reveal answer'}
              </span>
            </button>
          )}

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

          {/* Only for slides whose answers are prose. A bar chart needs no
              summary, and offering one there would be noise. */}
          {aiAvailable && isTextKind(slide?.kind) && (results?.count ?? 0) > 0 && (
            <button
              type="button"
              className={styles.controlButton}
              onClick={() => {
                if (currentSummary) setSummary(null);
                else void summarise();
              }}
              disabled={summarising}
              title="Group these answers into themes"
            >
              {summarising ? <Loader2 size={18} className={styles.spin} /> : <Sparkles size={18} />}
              <span className={styles.controlLabel}>
                {summarising ? 'Reading' : currentSummary ? 'Answers' : 'Summarise'}
              </span>
            </button>
          )}

          <QuestionButton
            open={questionsOpen}
            onToggle={() => {
              setQuestionsOpen((current) => !current);
            }}
          />

          <button
            type="button"
            className={styles.controlButton}
            data-active={showJoin}
            onClick={() => {
              setShowJoin((current) => !current);
            }}
            title="Show the joining code and QR again"
          >
            <QrCodeIcon size={18} />
            <span className={styles.controlLabel}>Join</span>
          </button>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={styles.controlButton}
                title="Download the results as a spreadsheet"
              >
                <Download size={18} />
                <span className={styles.controlLabel}>Export</span>
              </button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
              <DropdownMenu.Content className={styles.menu} sideOffset={8} align="end">
                {/* Every export is a CSV: it opens in Excel, Numbers and
                    Sheets without anyone being told how. */}
                <DropdownMenu.Item
                  className={styles.menuItem}
                  onSelect={() => {
                    download('csv');
                  }}
                >
                  Answers (CSV)
                  <span className={styles.menuHint}>One row per answer</span>
                </DropdownMenu.Item>

                <DropdownMenu.Item
                  className={styles.menuItem}
                  onSelect={() => {
                    download('statistics');
                  }}
                >
                  Statistics (CSV)
                  <span className={styles.menuHint}>Counts and shares per question</span>
                </DropdownMenu.Item>

                {hasQuiz && (
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => {
                      download('leaderboard');
                    }}
                  >
                    Leaderboard (CSV)
                    <span className={styles.menuHint}>Final scores</span>
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

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

      <AnimatePresence>
        {questionsOpen && (
          <QuestionPanel
            onClose={() => {
              setQuestionsOpen(false);
            }}
          />
        )}
      </AnimatePresence>

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
/* Join address                                                        */
/* ------------------------------------------------------------------ */

/**
 * Lets the presenter switch which address the room is told to open.
 *
 * Only shown when the machine has more than one. The server cannot tell
 * which network the audience's phones are on -- a laptop on Wi-Fi with a
 * phone hotspot attached has two, and the wrong one is unreachable with no
 * explanation on screen.
 */
function JoinAddressPicker({
  addresses,
  value,
  onChange,
}: {
  addresses: string[];
  value: string;
  onChange: (address: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1600);
      })
      .catch(() => {
        toast.error('Could not copy that address.');
      });
  };

  return (
    <div className={styles.addressRow}>
      <button type="button" className={styles.addressCopy} onClick={copy}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy link'}
      </button>

      {addresses.length > 1 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className={styles.addressCopy} title="Use a different network">
              Wrong address?
            </button>
          </DropdownMenu.Trigger>

          <DropdownMenu.Portal>
            <DropdownMenu.Content className={styles.menu} sideOffset={6} align="center">
              <p className={styles.menuNote}>
                This machine is on more than one network. Pick the one the room can reach.
              </p>

              {addresses.map((option) => (
                <DropdownMenu.Item
                  key={option}
                  className={styles.menuItem}
                  data-active={option === value}
                  onSelect={() => {
                    onChange(option);
                  }}
                >
                  {option.replace(/^https?:\/\//, '')}
                  {option === value && <Check size={14} />}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

/**
 * The numbers behind the chart.
 *
 * A bar chart shows the shape of the answers; this says how much of the
 * room they speak for. "100%" means nothing without knowing whether one
 * person answered or forty, and a presenter deciding whether to move on
 * needs the count, not the share.
 */
function ResultStats({
  results,
  participantCount,
  revealed,
}: {
  results: SlideResults;
  participantCount: number;
  revealed: boolean;
}) {
  const data = results.data as ResultData;
  const items: CountedItem[] = data.type === 'counts' ? data.items : [];

  const correct = items.filter((item) => item.correct === true);
  const hasKey = items.some((item) => item.correct !== undefined);

  const correctCount = correct.reduce((sum, item) => sum + item.count, 0);
  const rate = participantCount === 0 ? null : Math.round((results.count / participantCount) * 100);

  return (
    <div className={styles.stats}>
      <span className={styles.stat}>
        <strong>{results.count.toLocaleString()}</strong>
        {results.count === 1 ? ' answer' : ' answers'}
      </span>

      {participantCount > 0 && (
        <span className={styles.stat}>
          <strong>
            {results.count} of {participantCount}
          </strong>
          {' answered'}
          {rate !== null && <span className={styles.statRate}>{rate}%</span>}
        </span>
      )}

      {/* Only once the room has been told, or this would give the answer
          away from the corner of the screen. */}
      {hasKey && revealed && results.count > 0 && (
        <span className={styles.stat} data-tone="correct">
          <strong>{correctCount}</strong>
          {' correct'}
          <span className={styles.statRate}>
            {Math.round((correctCount / results.count) * 100)}%
          </span>
        </span>
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

    case 'heading':
      // The prompt is already rendered above as the slide title, so a
      // heading slide needs only its subtitle, if any. Repeating the title
      // here would print it twice.
      return null;

    case 'section_break':
      return <div className={styles.sectionBreak} aria-hidden="true" />;

    case 'video': {
      const url = text('url');
      return url === '' ? (
        <p className={styles.contentPlaceholder}>No video set</p>
      ) : (
        <p className={styles.contentPlaceholder}>
          Play the video from your own screen, then continue.
        </p>
      );
    }

    case 'embed': {
      const url = text('url');
      return url === '' ? (
        <p className={styles.contentPlaceholder}>Nothing embedded yet</p>
      ) : (
        // Sandboxed: an embedded page must not be able to script this one,
        // read its storage, or navigate the presenter away mid-session.
        <iframe
          src={url}
          className={styles.embed}
          title="Embedded content"
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
        />
      );
    }

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

/** Config values arrive as unknown; every use here wants a string. */
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function promptOf(slide: { config: Record<string, unknown> } | undefined): string {
  const prompt = slide?.config.prompt;
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : '';
}

function subtitleOf(slide: { config: Record<string, unknown> } | undefined): string {
  const subtitle = slide?.config.subtitle;
  return typeof subtitle === 'string' ? subtitle : '';
}

/** Kinds whose answers are prose, and so worth summarising. */
function isTextKind(kind: string | undefined): boolean {
  return kind === 'open_text' || kind === 'word_cloud' || kind === 'qa';
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

/** The AI reading of a wall of open text. */
function SummaryView({ summary, onClose }: { summary: TextSummary; onClose: () => void }) {
  const total = summary.themes.reduce((sum, theme) => sum + theme.count, 0);

  return (
    <motion.div
      className={styles.summary}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <p className={styles.summaryHeadline}>{summary.headline}</p>

      <ul className={styles.themes}>
        {summary.themes.map((theme) => (
          <li key={theme.label} className={styles.theme}>
            <div className={styles.themeBar}>
              <motion.div
                className={styles.themeFill}
                initial={{ width: 0 }}
                animate={{ width: `${String(total === 0 ? 0 : (theme.count / total) * 100)}%` }}
                transition={{ type: 'spring', stiffness: 120, damping: 20 }}
              />
            </div>
            <div className={styles.themeText}>
              <span className={styles.themeLabel}>{theme.label}</span>
              <span className={styles.themeCount}>{theme.count}</span>
            </div>
            {theme.example !== undefined && theme.example !== '' && (
              <p className={styles.themeExample}>{theme.example}</p>
            )}
          </li>
        ))}
      </ul>

      <button type="button" className={styles.summaryClose} onClick={onClose}>
        Show the answers instead
      </button>
    </motion.div>
  );
}
