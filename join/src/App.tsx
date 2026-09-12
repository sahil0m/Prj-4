import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionState, ParticipantSlide } from '@pulse/shared';
import {
  SessionConnection,
  clearQueue,
  type ConnectionStatus,
  type QuizResult,
} from './lib/session';
import { AnswerInput } from './components/AnswerInput';
import { ActionBar } from './components/ActionBar';
import styles from './App.module.css';

/**
 * The participant app.
 *
 * One screen at a time, and never more than one decision on screen. The
 * person holding this is looking at a projector, not at their phone.
 */

type Phase = 'code' | 'name' | 'live' | 'ended';

export function App() {
  const [phase, setPhase] = useState<Phase>('code');
  const [code, setCode] = useState(() => codeFromUrl());
  const [name, setName] = useState(() => {
    // Kept per device so a refresh mid-session does not turn someone into a
    // second, nameless player on the scoreboard.
    try {
      return localStorage.getItem('pulse.name') ?? '';
    } catch {
      return '';
    }
  });
  const [collectNames, setCollectNames] = useState(false);

  const [sessionTitle, setSessionTitle] = useState('');
  const [state, setState] = useState<SessionState | null>(null);
  const [slide, setSlide] = useState<ParticipantSlide | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(0);
  const [quizResult, setQuizResult] = useState<QuizResult | null>(null);

  // A quiz deck is the only one where a scoreboard means anything, and a
  // quiz result arriving is the signal that this deck has one.
  const [hasScores, setHasScores] = useState(false);

  const connection = useRef<SessionConnection | null>(null);

  // When this device first saw the current slide. The server measures
  // elapsed time authoritatively against its own countdown, but sending
  // ours covers the case where no countdown is running.
  const slideShownAt = useRef<number>(Date.now());

  /** A fresh slide clears the "sent" state so the new question is answerable. */
  const showSlide = useCallback((next: ParticipantSlide | null) => {
    setSlide(next);
    setSent(next?.answered === true);
    slideShownAt.current = Date.now();
    // A result belongs to the slide it came from; carrying it forward would
    // tell someone they were right about a question they have not seen.
    setQuizResult(null);
  }, []);

  useEffect(() => {
    return () => {
      connection.current?.close();
    };
  }, []);

  const connect = async (joinCode: string, displayName?: string) => {
    setBusy(true);
    setError(null);

    const conn = new SessionConnection({
      onState: setState,
      onSlide: showSlide,
      onResults: () => {
        // Participant-side results land with the charts; ignored for now.
      },
      onEnded: () => {
        setPhase('ended');
        clearQueue();
      },
      onStatus: setStatus,
      onAnswerAccepted: () => {
        setPending(connection.current?.pendingCount ?? 0);
        setSent(true);
      },
      onQuizResult: (result) => {
        setQuizResult(result);
        setHasScores(true);
      },
    });

    const result = await conn.join(joinCode, displayName);
    setBusy(false);

    if (!result.ok) {
      setError(result.message);
      conn.close();
      return;
    }

    connection.current = conn;

    if (displayName !== undefined && displayName !== '') {
      try {
        localStorage.setItem('pulse.name', displayName);
      } catch {
        // Private browsing refuses storage; the name still holds for this tab.
      }
    }

    setState(result.session);
    showSlide(result.slide);
    setCollectNames(result.collectNames);

    // Ask for a name only when the deck wants one and we do not have it yet.
    if (result.collectNames && result.displayName === '' && displayName === undefined) {
      // A name already on this device is used without asking again.
      const remembered = name.trim();

      if (remembered !== '') {
        void connect(joinCode, remembered);
        return;
      }

      setPhase('name');
      return;
    }

    setPhase('live');
  };

  const submit = (payload: unknown) => {
    if (!slide || !connection.current) return;

    // Marked as sent immediately. The answer is queued and retried if the
    // network is down, so telling the person it failed would be a lie.
    setSent(true);

    // Quiz kinds score on speed. A non-quiz slide ignores the field, so it
    // is simpler to always send it than to branch on the kind here.
    const timed = { ...(payload as object), elapsedMs: Date.now() - slideShownAt.current };

    void connection.current.answer(slide.id, timed).then((result) => {
      setPending(connection.current?.pendingCount ?? 0);
      if (!result.ok) {
        setSent(false);
        setError(result.message);
      }
    });
  };

  /* ---------------- screens ---------------- */

  if (phase === 'code') {
    return (
      <CodeScreen
        code={code}
        setCode={setCode}
        busy={busy}
        error={error}
        onJoin={() => {
          void connect(code);
        }}
        onTitle={setSessionTitle}
      />
    );
  }

  if (phase === 'name') {
    return (
      <NameScreen
        name={name}
        setName={setName}
        busy={busy}
        onSubmit={() => {
          void connect(code, name.trim());
        }}
      />
    );
  }

  if (phase === 'ended') {
    return (
      <Centered>
        <div className={styles.endMark} aria-hidden="true">
          <Tick />
        </div>
        <h1 className={styles.endTitle}>That is the end</h1>
        <p className={styles.endBody}>Thanks for taking part.</p>
        <button
          type="button"
          className={styles.ghostButton}
          onClick={() => {
            window.location.reload();
          }}
        >
          Join another session
        </button>
      </Centered>
    );
  }

  /* ---------------- live ---------------- */

  const open = state?.participationOpen === true && slide !== null;
  const answerable = open && !sent;

  return (
    <div className={styles.live}>
      <header className={styles.bar}>
        <span className={styles.barTitle}>{sessionTitle || 'Live'}</span>
        <ConnectionBadge status={status} pending={pending} />
      </header>

      <main className={styles.stage}>
        {!slide ? (
          <Waiting message="Waiting for the presenter" />
        ) : quizResult ? (
          <QuizOutcome result={quizResult} />
        ) : sent ? (
          <Sent pending={pending} />
        ) : !open ? (
          <Waiting message="This question is closed" />
        ) : (
          <>
            <h1 className={styles.prompt}>{promptOf(slide)}</h1>
            {subtitleOf(slide) !== '' && <p className={styles.subtitle}>{subtitleOf(slide)}</p>}

            <div className={styles.answer}>
              <AnswerInput
                kind={slide.kind}
                config={slide.config}
                disabled={!answerable}
                onSubmit={submit}
              />
            </div>
          </>
        )}

        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </main>

      {collectNames && name !== '' && (
        <footer className={styles.footer}>Answering as {name}</footer>
      )}

      {connection.current && <ActionBar connection={connection.current} showScores={hasScores} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function CodeScreen({
  code,
  setCode,
  busy,
  error,
  onJoin,
  onTitle,
}: {
  code: string;
  setCode: (value: string) => void;
  busy: boolean;
  error: string | null;
  onJoin: () => void;
  onTitle: (title: string) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  // Looks the code up as soon as it is complete, so the person sees the
  // session name before committing — and a typo is caught immediately.
  useEffect(() => {
    if (code.length !== 6) {
      setFound(null);
      return;
    }

    let cancelled = false;
    setChecking(true);

    void fetch(`/api/sessions/lookup?code=${code}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { title?: string } | null) => {
        if (cancelled) return;
        const title = data?.title ?? null;
        setFound(title);
        if (title) onTitle(title);
      })
      .catch(() => {
        if (!cancelled) setFound(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code, onTitle]);

  return (
    <Centered>
      <div className={styles.logo} aria-hidden="true">
        <Waves />
      </div>

      <h1 className={styles.joinTitle}>Join the session</h1>
      <p className={styles.joinBody}>Enter the 6-digit code on the screen.</p>

      <input
        className={styles.codeInput}
        value={code}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        maxLength={6}
        aria-label="Six digit join code"
        onChange={(e) => {
          setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && code.length === 6) onJoin();
        }}
      />

      <div className={styles.lookup}>
        {checking && <span className={styles.lookupChecking}>Checking…</span>}
        {!checking && found !== null && <span className={styles.lookupFound}>{found}</span>}
        {!checking && code.length === 6 && found === null && (
          <span className={styles.lookupMissing}>No session with that code</span>
        )}
      </div>

      <button
        type="button"
        className={styles.primaryButton}
        disabled={code.length !== 6 || busy || found === null}
        onClick={onJoin}
      >
        {busy ? 'Joining…' : 'Join'}
      </button>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </Centered>
  );
}

/**
 * Asks for a name.
 *
 * A name is required rather than optional. This screen only appears when
 * the deck actually needs one — a quiz or a leaderboard — and a scoreboard
 * of anonymous rows tells the room nothing. Decks that do not need a name
 * never reach this screen at all.
 */
function NameScreen({
  name,
  setName,
  busy,
  onSubmit,
}: {
  name: string;
  setName: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= 60;

  return (
    <Centered>
      <h1 className={styles.joinTitle}>What should we call you?</h1>
      <p className={styles.joinBody}>
        This appears on the scoreboard, so pick something the room will recognise.
      </p>

      <input
        className={styles.nameInput}
        value={name}
        maxLength={60}
        autoFocus
        placeholder="Your name"
        autoComplete="name"
        enterKeyHint="go"
        onChange={(e) => {
          setName(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) onSubmit();
        }}
      />

      <button
        type="button"
        className={styles.primaryButton}
        disabled={busy || !valid}
        onClick={onSubmit}
      >
        {busy ? 'Joining…' : 'Continue'}
      </button>
    </Centered>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.centered}>
      <div className={styles.centeredInner}>{children}</div>
    </div>
  );
}

function Waiting({ message }: { message: string }) {
  return (
    <div className={styles.waiting}>
      <div className={styles.pulse} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className={styles.waitingText}>{message}</p>
    </div>
  );
}

function Sent({ pending }: { pending: number }) {
  return (
    <div className={styles.waiting}>
      <div className={styles.sentMark} aria-hidden="true">
        <Tick />
      </div>
      <p className={styles.sentTitle}>Answer sent</p>
      <p className={styles.waitingText}>
        {pending > 0 ? 'Saved — it will send when you are back online.' : 'Look at the screen.'}
      </p>
    </div>
  );
}

/**
 * How this device did on a quiz question.
 *
 * Shows only this person's own result. Sending the whole leaderboard to
 * every phone would turn a quiz into a copying exercise, and seeing your
 * own rank is the part that makes someone want the next question.
 */
function QuizOutcome({ result }: { result: QuizResult }) {
  return (
    <div className={styles.waiting}>
      <div className={result.correct ? styles.sentMark : styles.wrongMark} aria-hidden="true">
        {result.correct ? <Tick /> : <Cross />}
      </div>

      <p className={styles.sentTitle}>{result.correct ? 'Correct' : 'Not this time'}</p>

      {result.correct && result.points > 0 && (
        <p className={styles.points}>+{result.points.toLocaleString()}</p>
      )}

      <p className={styles.waitingText}>
        {result.totalScore.toLocaleString()} points
        {result.rank !== null ? ` \u00b7 ${ordinal(result.rank)} place` : ''}
      </p>
    </div>
  );
}

/** 1st, 2nd, 3rd, 4th - the form a person reads without thinking. */
function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${String(n)}th`;

  switch (n % 10) {
    case 1:
      return `${String(n)}st`;
    case 2:
      return `${String(n)}nd`;
    case 3:
      return `${String(n)}rd`;
    default:
      return `${String(n)}th`;
  }
}

function Cross() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function ConnectionBadge({ status, pending }: { status: ConnectionStatus; pending: number }) {
  if (status === 'connected' && pending === 0) {
    return <span className={styles.badge} data-status="connected" aria-label="Connected" />;
  }

  return (
    <span className={styles.badgeText} data-status={status}>
      {pending > 0
        ? `${String(pending)} saved`
        : status === 'connected'
          ? 'Online'
          : 'Reconnecting…'}
    </span>
  );
}

function Tick() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12.5l5.5 5.5L20 7" />
    </svg>
  );
}

function Waves() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path
        d="M7.4 7.4a6.5 6.5 0 000 9.2M16.6 16.6a6.5 6.5 0 000-9.2M4.2 4.2a11 11 0 000 15.6M19.8 19.8a11 11 0 000-15.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A code in the URL — from a QR scan — skips straight past typing it. */
function codeFromUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('code');
  if (fromQuery && /^\d{6}$/.test(fromQuery)) return fromQuery;

  const fromPath = /\/(\d{6})$/.exec(window.location.pathname);
  return fromPath?.[1] ?? '';
}

function promptOf(slide: ParticipantSlide): string {
  const prompt = slide.config.prompt;
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : 'Your answer';
}

function subtitleOf(slide: ParticipantSlide): string {
  const subtitle = slide.config.subtitle;
  return typeof subtitle === 'string' ? subtitle : '';
}
