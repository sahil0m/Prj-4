import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Monitor,
  Smartphone,
  LogOut,
  KeyRound,
  ShieldCheck,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, type ActiveSession } from '../lib/api';
import { useAuth } from '../lib/auth-store';
import styles from './Settings.module.css';

/**
 * Account settings.
 *
 * Three things a person genuinely needs: change their password, see where
 * they are signed in, and get out of somewhere they should not be. Anything
 * else here would be a preference nobody changes.
 */
export function Settings() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);

  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const result = await api.sessions();
      setSessions(result.sessions);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void loadSessions();

    // Shown so someone hitting the cap understands why the AI stopped,
    // rather than assuming it is broken.
    void api
      .aiQuota()
      .then((result) => {
        setQuota({ used: result.used, limit: result.limit });
      })
      .catch(() => {
        setQuota(null);
      });
  }, [loadSessions]);

  const revoke = async (session: ActiveSession) => {
    try {
      await api.revokeSession(session.id);
      toast.success('Signed out on that device');
      await loadSessions();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not work.');
    }
  };

  const signOutEverywhere = async () => {
    try {
      await api.logoutEverywhere();
      toast.success('Signed out everywhere');
      // Including here: this device's tokens are revoked too, so staying on
      // the page would show an account that no longer has a session.
      await signOut();
      await navigate('/signin');
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
        <h1 className={styles.title}>Account</h1>
      </header>

      <main className={styles.main}>
        <motion.div
          className={styles.content}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {/* ---------------- who you are ---------------- */}
          <section className={styles.card}>
            <div className={styles.identity}>
              <span className={styles.avatar} aria-hidden="true">
                {(user?.name ?? '?').charAt(0).toUpperCase()}
              </span>
              <div>
                <p className={styles.name}>{user?.name}</p>
                <p className={styles.email}>{user?.email}</p>
              </div>
            </div>

            <div className={styles.tags}>
              {user?.providers.includes('google') && <span className={styles.tag}>Google</span>}
              {user?.hasPassword && <span className={styles.tag}>Password</span>}
              {user?.role === 'admin' && (
                <span className={`${styles.tag} ${styles.tagAccent}`}>Admin</span>
              )}
            </div>
          </section>

          {/* ---------------- AI allowance ---------------- */}
          {quota && (
            <section className={styles.card}>
              <h2 className={styles.sectionTitle}>
                <Sparkles size={16} />
                AI requests today
              </h2>
              <div className={styles.quotaBar}>
                <div
                  className={styles.quotaFill}
                  data-full={quota.used >= quota.limit}
                  style={{ width: `${String(Math.min(100, (quota.used / quota.limit) * 100))}%` }}
                />
              </div>
              <p className={styles.quotaText}>
                {quota.used} of {quota.limit} used. Resets at midnight.
              </p>
            </section>
          )}

          {/* ---------------- password ---------------- */}
          <PasswordCard hasPassword={user?.hasPassword === true} />

          {/* ---------------- devices ---------------- */}
          <section className={styles.card}>
            <h2 className={styles.sectionTitle}>
              <ShieldCheck size={16} />
              Where you are signed in
            </h2>

            {sessions === null ? (
              <div className={styles.loading}>
                <Loader2 size={18} className={styles.spin} />
              </div>
            ) : sessions.length === 0 ? (
              <p className={styles.muted}>No other devices.</p>
            ) : (
              <ul className={styles.deviceList}>
                {sessions.map((session) => (
                  <li key={session.id} className={styles.device} data-current={session.current}>
                    <span className={styles.deviceIcon}>
                      {isPhone(session.userAgent) ? (
                        <Smartphone size={17} />
                      ) : (
                        <Monitor size={17} />
                      )}
                    </span>

                    <span className={styles.deviceText}>
                      <span className={styles.deviceName}>
                        {describeDevice(session.userAgent)}
                        {session.current && <span className={styles.currentTag}>this device</span>}
                      </span>
                      <span className={styles.deviceMeta}>
                        Signed in {relativeTime(session.createdAt)}
                      </span>
                    </span>

                    {!session.current && (
                      <button
                        type="button"
                        className={styles.revokeButton}
                        onClick={() => {
                          void revoke(session);
                        }}
                      >
                        Sign out
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => {
                void signOutEverywhere();
              }}
            >
              <LogOut size={15} />
              Sign out everywhere
            </button>
          </section>
        </motion.div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Password                                                            */
/* ------------------------------------------------------------------ */

function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = next.length >= 12 && (!hasPassword || current.length > 0);

  const change = async () => {
    if (!valid || busy) return;

    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      // Changing a password signs out every other device by design, so the
      // message says so rather than leaving it as a surprise.
      toast.success('Password changed', {
        description: 'You have been signed out on every other device.',
      });
      setCurrent('');
      setNext('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card}>
      <h2 className={styles.sectionTitle}>
        <KeyRound size={16} />
        {hasPassword ? 'Change your password' : 'Set a password'}
      </h2>

      {!hasPassword && (
        <p className={styles.muted}>
          You sign in with Google. Adding a password gives you a second way in.
        </p>
      )}

      <div className={styles.fields}>
        {hasPassword && (
          <label className={styles.field}>
            <span className={styles.label}>Current password</span>
            <input
              type="password"
              className={styles.input}
              value={current}
              autoComplete="current-password"
              onChange={(e) => {
                setCurrent(e.target.value);
              }}
            />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.label}>New password</span>
          <input
            type="password"
            className={styles.input}
            value={next}
            autoComplete="new-password"
            placeholder="At least 12 characters"
            onChange={(e) => {
              setNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid) void change();
            }}
          />
        </label>
      </div>

      <button
        type="button"
        className={styles.primaryButton}
        disabled={!valid || busy}
        onClick={() => {
          void change();
        }}
      >
        {busy ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
      </button>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isPhone(userAgent: string): boolean {
  return /iphone|android|mobile/i.test(userAgent);
}

/**
 * A user agent reduced to something a person recognises.
 *
 * "Chrome on Windows" is what someone needs to decide whether a session is
 * theirs; the full string is unreadable and tells them nothing useful.
 */
function describeDevice(userAgent: string): string {
  const browser = /edg/i.test(userAgent)
    ? 'Edge'
    : /chrome|crios/i.test(userAgent)
      ? 'Chrome'
      : /firefox|fxios/i.test(userAgent)
        ? 'Firefox'
        : /safari/i.test(userAgent)
          ? 'Safari'
          : 'A browser';

  const platform = /iphone|ipad/i.test(userAgent)
    ? 'iOS'
    : /android/i.test(userAgent)
      ? 'Android'
      : /mac/i.test(userAgent)
        ? 'macOS'
        : /windows/i.test(userAgent)
          ? 'Windows'
          : /linux/i.test(userAgent)
            ? 'Linux'
            : '';

  return platform === '' ? browser : `${browser} on ${platform}`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  const days = Math.round(hours / 24);
  return `${String(days)}d ago`;
}
