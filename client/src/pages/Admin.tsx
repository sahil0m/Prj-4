import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Users,
  Layers,
  Radio,
  Activity,
  Search,
  ShieldOff,
  ShieldCheck,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type AdminOverview, type AdminUser, type AdminSession } from '../lib/api';
import styles from './Admin.module.css';

/**
 * The admin area.
 *
 * Four questions, four sections: who is using it, is anyone abusing it, is
 * the AI quota about to run out, and is anything broken. Screens beyond
 * those are a maintenance cost rather than a feature.
 */
export function Admin() {
  const navigate = useNavigate();

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [search, setSearch] = useState('');
  const [denied, setDenied] = useState(false);
  const [suspending, setSuspending] = useState<AdminUser | null>(null);

  const load = useCallback(async (query: string) => {
    try {
      const [stats, userPage, live] = await Promise.all([
        api.adminOverview(),
        api.adminUsers({ search: query || undefined }),
        api.adminSessions(),
      ]);

      setOverview(stats);
      setUsers(userPage.users);
      setSessions(live.sessions);
    } catch (err) {
      // The server returns 404 rather than 403 to a non-admin, so this is
      // the expected shape of "you are not an admin" as well as of a real
      // missing route.
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        setDenied(true);
        return;
      }
      toast.error('The admin data could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void load(search);
  }, [load, search]);

  // A live view that never updates is worse than no live view; this is slow
  // enough not to matter and fast enough to be current.
  useEffect(() => {
    const timer = setInterval(() => {
      void load(search);
    }, 15_000);

    return () => {
      clearInterval(timer);
    };
  }, [load, search]);

  if (denied) {
    return (
      <div className={styles.denied}>
        <h1 className={styles.deniedTitle}>Not found</h1>
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

  /**
   * Suspending asks for a reason; restoring does not.
   *
   * The reason is stored and shown to the person when they next try to sign
   * in, so it has to be written by a human rather than left blank.
   */
  const suspend = async (user: AdminUser, reason: string) => {
    try {
      await api.adminSuspend(user.id, !user.suspended, reason);
      toast.success(user.suspended ? 'Account restored' : 'Account suspended');
      setSuspending(null);
      await load(search);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not work.');
    }
  };

  const setRole = async (user: AdminUser, role: 'user' | 'admin') => {
    try {
      await api.adminRole(user.id, role);
      toast.success(role === 'admin' ? 'Made an admin' : 'Admin access removed');
      await load(search);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not work.');
    }
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
        <h1 className={styles.title}>Admin</h1>
      </header>

      <main className={styles.main}>
        {!overview ? (
          <div className={styles.loading}>
            <Loader2 size={22} className={styles.spin} />
          </div>
        ) : (
          <motion.div
            className={styles.content}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* ---------------- at a glance ---------------- */}
            <section className={styles.stats}>
              <Stat
                icon={<Users size={17} />}
                label="People"
                value={overview.users.total}
                detail={`${String(overview.users.active7d)} active this week`}
              />
              <Stat
                icon={<Layers size={17} />}
                label="Decks"
                value={overview.content.decks}
                detail={`${String(overview.content.sessions)} sessions run`}
              />
              <Stat
                icon={<Radio size={17} />}
                label="Live now"
                value={overview.content.liveSessions}
                detail={`${overview.content.responses.toLocaleString()} answers total`}
                highlight={overview.content.liveSessions > 0}
              />
              <Stat
                icon={<Sparkles size={17} />}
                label="AI today"
                value={overview.ai.requestsToday}
                detail={
                  overview.ai.configured
                    ? overview.ai.providers.join(', ')
                    : 'No provider configured'
                }
              />
            </section>

            {/* ---------------- health ---------------- */}
            <section className={styles.health} data-ok={overview.health.database.ok}>
              <Activity size={16} />
              <span>
                Database {overview.health.database.ok ? 'responding' : 'unreachable'} in{' '}
                {overview.health.database.latencyMs}ms
              </span>
              <span className={styles.healthSpacer} />
              <span className={styles.uptime}>
                up {formatUptime(overview.health.uptimeSeconds)}
              </span>
            </section>

            {/* ---------------- live sessions ---------------- */}
            {sessions.length > 0 && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>Running now</h2>
                <div className={styles.sessionList}>
                  {sessions.map((session) => (
                    <div key={session.id} className={styles.sessionRow}>
                      <span className={styles.sessionCode}>{session.joinCode}</span>
                      <span className={styles.sessionText}>
                        <span className={styles.sessionTitle}>{session.title}</span>
                        <span className={styles.sessionOwner}>{session.ownerEmail}</span>
                      </span>
                      <span className={styles.sessionStats}>
                        {session.participants} in the room · {session.responses} answers
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ---------------- users ---------------- */}
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>People</h2>
                <div className={styles.searchBox}>
                  <Search size={15} className={styles.searchIcon} aria-hidden="true" />
                  <input
                    className={styles.search}
                    value={search}
                    placeholder="Search by name or email"
                    onChange={(e) => {
                      setSearch(e.target.value);
                    }}
                  />
                </div>
              </div>

              {users === null ? (
                <div className={styles.loading}>
                  <Loader2 size={20} className={styles.spin} />
                </div>
              ) : users.length === 0 ? (
                <p className={styles.emptyText}>No accounts match that search.</p>
              ) : (
                <div className={styles.table}>
                  {users.map((user) => (
                    <div key={user.id} className={styles.userRow} data-suspended={user.suspended}>
                      <span className={styles.userText}>
                        <span className={styles.userName}>
                          {user.name}
                          {user.role === 'admin' && <span className={styles.tag}>admin</span>}
                          {user.suspended && (
                            <span className={`${styles.tag} ${styles.tagDanger}`}>suspended</span>
                          )}
                        </span>
                        <span className={styles.userEmail}>{user.email}</span>
                      </span>

                      <span className={styles.userStats}>
                        {user.deckCount} decks · {user.sessionCount} sessions
                        {user.aiRequestsToday > 0 && ` · ${String(user.aiRequestsToday)} AI`}
                      </span>

                      <span className={styles.userActions}>
                        <button
                          type="button"
                          className={styles.smallButton}
                          onClick={() => {
                            void setRole(user, user.role === 'admin' ? 'user' : 'admin');
                          }}
                        >
                          {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                        </button>

                        <button
                          type="button"
                          className={`${styles.smallButton} ${user.suspended ? '' : styles.dangerButton}`}
                          onClick={() => {
                            // Restoring is immediate; suspending asks why.
                            if (user.suspended) void suspend(user, '');
                            else setSuspending(user);
                          }}
                        >
                          {user.suspended ? (
                            <>
                              <ShieldCheck size={14} />
                              Restore
                            </>
                          ) : (
                            <>
                              <ShieldOff size={14} />
                              Suspend
                            </>
                          )}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </motion.div>
        )}
      </main>

      {suspending && (
        <SuspendDialog
          user={suspending}
          onCancel={() => {
            setSuspending(null);
          }}
          onConfirm={(reason) => {
            void suspend(suspending, reason);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Suspend                                                             */
/* ------------------------------------------------------------------ */

/** Asks why, because the reason is shown to the person being suspended. */
function SuspendDialog({
  user,
  onCancel,
  onConfirm,
}: {
  user: AdminUser;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div className={styles.dialog}>
        <h2 className={styles.dialogTitle}>Suspend {user.name}?</h2>
        <p className={styles.dialogBody}>
          They will be signed out immediately and cannot sign back in. Their decks and past sessions
          are kept.
        </p>

        <label className={styles.dialogLabel} htmlFor="suspend-reason">
          Reason — shown to them when they try to sign in
        </label>
        <input
          id="suspend-reason"
          className={styles.dialogInput}
          value={reason}
          maxLength={300}
          autoFocus
          placeholder="Repeated abuse of the AI quota"
          onChange={(e) => {
            setReason(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid) onConfirm(reason.trim());
          }}
        />

        <div className={styles.dialogActions}>
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.confirmDanger}
            disabled={!valid}
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            Suspend
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Stat({
  icon,
  label,
  value,
  detail,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  detail: string;
  highlight?: boolean;
}) {
  return (
    <div className={styles.stat} data-highlight={highlight}>
      <span className={styles.statIcon}>{icon}</span>
      <span className={styles.statValue}>{value.toLocaleString()}</span>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statDetail}>{detail}</span>
    </div>
  );
}

/** "3d 4h" rather than "273600 seconds". */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}
