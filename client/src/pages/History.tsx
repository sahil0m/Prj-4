import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Download,
  Users,
  MessageSquare,
  Radio,
  Loader2,
  FileSpreadsheet,
  Trophy,
  Braces,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { api, type PastSession } from '../lib/api';
import styles from './History.module.css';

/**
 * Every session this account has run.
 *
 * The results of a session outlive the session. Until this page existed the
 * only route to an export was the presenter view, so closing it lost access
 * to the numbers — a teacher who ran a quiz on Monday could not get
 * Monday's scores on Tuesday.
 */
export function History() {
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<PastSession[] | null>(null);

  /*
   * The date range.
   *
   * A teacher looking for "the quizzes I ran in March" was scrolling a
   * list sorted by date and downloading them one at a time. Both ends are
   * optional, so this is also just "everything since the first of the
   * month" without having to name an end.
   */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSessions(null);

    void api
      .listSessions({ from: from || undefined, to: to || undefined })
      .then((result) => {
        if (!cancelled) setSessions(result.sessions);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const filtered = from !== '' || to !== '';

  const download = (sessionId: string, format: 'csv' | 'leaderboard' | 'json') => {
    // A navigation rather than fetch-and-blob: the response carries a
    // Content-Disposition header, so the browser names the file correctly
    // and nothing is held in memory.
    window.open(`/api/sessions/${sessionId}/export?format=${format}`, '_blank');
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
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
        <h1 className={styles.title}>Past sessions</h1>

        <div className={styles.filters}>
          <label className={styles.filter}>
            <span className={styles.filterLabel}>From</span>
            <input
              type="date"
              className={styles.date}
              value={from}
              // Cannot start after it ends; the browser enforces it rather
              // than the page having to explain an empty result.
              max={to || undefined}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
          </label>

          <label className={styles.filter}>
            <span className={styles.filterLabel}>To</span>
            <input
              type="date"
              className={styles.date}
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </label>

          {filtered && (
            <button
              type="button"
              className={styles.clear}
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Clear
            </button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        {sessions === null ? (
          <div className={styles.loading}>
            <Loader2 size={22} className={styles.spin} />
          </div>
        ) : sessions.length === 0 ? (
          <div className={styles.empty}>
            <Radio size={30} className={styles.emptyIcon} />

            {/* An empty range and an empty history need different advice.
                Telling someone to go and present something, when they have
                presented plenty and merely picked the wrong fortnight, is
                the sort of thing that makes a filter feel broken. */}
            {filtered ? (
              <>
                <h2 className={styles.emptyTitle}>Nothing in these dates</h2>
                <p className={styles.emptyBody}>
                  No sessions ran in that range. Try widening it, or clear the filter.
                </p>
                <button
                  type="button"
                  className={styles.clear}
                  onClick={() => {
                    setFrom('');
                    setTo('');
                  }}
                >
                  Clear dates
                </button>
              </>
            ) : (
              <>
                <h2 className={styles.emptyTitle}>Nothing run yet</h2>
                <p className={styles.emptyBody}>
                  Present a deck and it will appear here, with its results to download.
                </p>
              </>
            )}
          </div>
        ) : (
          <motion.div
            className={styles.list}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            {groupByDay(sessions).map((group) => (
              <section key={group.label} className={styles.group}>
                <h2 className={styles.groupLabel}>{group.label}</h2>

                {group.sessions.map((session) => (
                  <article key={session.id} className={styles.row} data-live={isLive(session)}>
                    <div className={styles.rowText}>
                      <span className={styles.rowTitle}>
                        {session.title}
                        {isLive(session) && <span className={styles.liveTag}>live now</span>}
                      </span>
                      <span className={styles.rowMeta}>
                        {formatTime(session.startedAt)} · {formatDuration(session)}
                      </span>
                    </div>

                    <div className={styles.stats}>
                      <span className={styles.stat} title="People who joined">
                        <Users size={14} />
                        {session.participants}
                      </span>
                      <span className={styles.stat} title="Answers collected">
                        <MessageSquare size={14} />
                        {session.responses}
                      </span>
                    </div>

                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          className={styles.downloadButton}
                          // Nothing to download from a session nobody
                          // answered, and offering it would produce an empty
                          // file that looks like a bug.
                          disabled={session.responses === 0}
                        >
                          <Download size={15} />
                          Download
                        </button>
                      </DropdownMenu.Trigger>

                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className={styles.menu} sideOffset={6} align="end">
                          <DropdownMenu.Item
                            className={styles.menuItem}
                            onSelect={() => {
                              download(session.id, 'csv');
                            }}
                          >
                            <FileSpreadsheet size={15} />
                            <span>
                              Every answer
                              <span className={styles.menuHint}>CSV, one row per answer</span>
                            </span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            className={styles.menuItem}
                            onSelect={() => {
                              download(session.id, 'leaderboard');
                            }}
                          >
                            <Trophy size={15} />
                            <span>
                              Scores
                              <span className={styles.menuHint}>CSV, final standings</span>
                            </span>
                          </DropdownMenu.Item>

                          <DropdownMenu.Item
                            className={styles.menuItem}
                            onSelect={() => {
                              download(session.id, 'json');
                            }}
                          >
                            <Braces size={15} />
                            <span>
                              Everything
                              <span className={styles.menuHint}>JSON, all results</span>
                            </span>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </article>
                ))}
              </section>
            ))}
          </motion.div>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isLive(session: PastSession): boolean {
  return session.state === 'live' || session.state === 'paused';
}

/**
 * Groups by day, with today and yesterday named.
 *
 * A list of raw dates is hard to scan; "Today" and "Yesterday" are what
 * someone actually looks for when they want the session they just ran.
 */
function groupByDay(sessions: PastSession[]): { label: string; sessions: PastSession[] }[] {
  const groups = new Map<string, PastSession[]>();

  for (const session of sessions) {
    const label = dayLabel(new Date(session.startedAt));
    groups.set(label, [...(groups.get(label) ?? []), session]);
  }

  return [...groups.entries()].map(([label, list]) => ({ label, sessions: list }));
}

function dayLabel(date: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });

  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    // The year only when it is not this one, which is how people write dates.
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(session: PastSession): string {
  if (session.endedAt === null) return 'still running';

  const minutes = Math.round(
    (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60_000,
  );

  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}
