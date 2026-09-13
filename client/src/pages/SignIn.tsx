import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Eye, EyeOff, Loader2, AlertCircle, Check, ArrowRight, Radio } from 'lucide-react';
import { useAuth } from '../lib/auth-store';
import { api } from '../lib/api';
import styles from './SignIn.module.css';

type Mode = 'signin' | 'signup';

/* ------------------------------------------------------------------ */
/* Password strength                                                   */
/* ------------------------------------------------------------------ */

interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

/**
 * Scores a password on the things that actually matter — length first,
 * then variety — rather than demanding a symbol. A long passphrase beats
 * `Passw0rd!` and the meter should say so.
 */
function scorePassword(password: string): Strength {
  if (!password) return { score: 0, label: '', hint: '' };

  let score = 0;
  if (password.length >= 12) score += 2;
  else if (password.length >= 8) score += 1;
  if (password.length >= 16) score += 1;

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(password)).length;
  if (variety >= 3) score += 1;

  // Obvious patterns cancel out length.
  if (/^(.)\1+$/.test(password) || /^(012|123|abc|qwe|password)/i.test(password)) score = 0;

  const clamped = Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;

  const labels = ['Too weak', 'Weak', 'Okay', 'Strong', 'Excellent'];
  const hints = [
    'Try a few unrelated words together.',
    'Longer is stronger. Aim for 12 characters.',
    'Nearly there. A few more characters helps.',
    'Good password.',
    'Excellent password.',
  ];

  return { score: clamped, label: labels[clamped] ?? '', hint: hints[clamped] ?? '' };
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function SignIn() {
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const { busy, error, providers, signIn, signUp, loadProviders, clearError } = useAuth();
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // Move focus to the first field when the form changes shape, so keyboard
  // users are not left stranded at the bottom of the page.
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [mode]);

  const strength = useMemo(() => scorePassword(password), [password]);

  /** Surfaced from the OAuth callback via the query string. */
  const oauthError = useMemo(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (!code) return null;
    const messages: Record<string, string> = {
      cancelled: 'Google sign-in was cancelled.',
      expired: 'That sign-in attempt timed out. Please try again.',
      invalid_state: 'That sign-in link was not valid. Please try again.',
      google_failed: 'Google sign-in did not work. Please try again.',
      // Not a fault to retry: someone decided this.
      account_suspended: 'This account has been suspended. Contact an administrator.',
      email_unverified_at_provider:
        'That email already has an account here. Sign in with your password first, then link Google.',
    };
    return messages[code] ?? 'Sign-in failed. Please try again.';
  }, []);

  const handleSubmit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void (async () => {
      if (mode === 'signin') await signIn(email, password);
      else await signUp(name, email, password);
    })();
  };

  const switchMode = (next: Mode) => {
    clearError();
    setMode(next);
    setPassword('');
  };

  const isSignUp = mode === 'signup';

  return (
    <div className={styles.page}>
      {/* Decorative aura layers. Marked aria-hidden: they carry no meaning. */}
      <div className={styles.auraOne} aria-hidden="true" />
      <div className={styles.auraTwo} aria-hidden="true" />

      <div className={styles.split}>
        {/* -------- left: the pitch -------- */}
        <aside className={styles.pitch}>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: [0, 0, 0.2, 1] }}
          >
            <div className={styles.brand}>
              <span className={styles.brandMark} aria-hidden="true">
                <Radio size={18} />
              </span>
              <span className={styles.brandName}>Pulse</span>
            </div>

            <h1 className={styles.pitchTitle}>
              Ask a room.
              <br />
              <em>See what it thinks.</em>
            </h1>

            <p className={styles.pitchBody}>
              Live polls, word clouds and quizzes your audience answers on their phones. No app, no
              account, no waiting.
            </p>

            <ul className={styles.points}>
              {[
                'Answers on screen in under a second',
                'Works when the wifi drops',
                'Every feature free, for everyone',
              ].map((point, i) => (
                <motion.li
                  key={point}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: 0.2 + i * 0.08, ease: [0, 0, 0.2, 1] }}
                >
                  <span className={styles.tick} aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                  {point}
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </aside>

        {/* -------- right: the form -------- */}
        <main className={styles.formSide}>
          <motion.div
            className={`glass ${styles.card}`}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.2, 0, 0.1, 1] }}
          >
            <div className={styles.tabs} role="tablist" aria-label="Sign in or create an account">
              {(['signin', 'signup'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  className={styles.tab}
                  onClick={() => {
                    switchMode(value);
                  }}
                >
                  {mode === value && (
                    <motion.span
                      layoutId="tab-pill"
                      className={styles.tabPill}
                      transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                    />
                  )}
                  <span className={styles.tabLabel}>
                    {value === 'signin' ? 'Sign in' : 'Create account'}
                  </span>
                </button>
              ))}
            </div>

            <div className={styles.heading}>
              <h2>{isSignUp ? 'Create your account' : 'Welcome back'}</h2>
              <p>
                {isSignUp
                  ? 'Free forever. No card, no trial.'
                  : 'Sign in to your decks and results.'}
              </p>
            </div>

            {/* OAuth error from the redirect, shown once on arrival. */}
            {oauthError && !error && (
              <div className={styles.alert} role="alert">
                <AlertCircle size={15} />
                <span>{oauthError}</span>
              </div>
            )}

            <AnimatePresence>
              {error && (
                <motion.div
                  className={styles.alert}
                  role="alert"
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 16 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.22, ease: [0.2, 0, 0.1, 1] }}
                >
                  <AlertCircle size={15} />
                  <span>{error.message}</span>
                </motion.div>
              )}
            </AnimatePresence>

            {providers.google && (
              <>
                <button
                  type="button"
                  className={styles.googleButton}
                  onClick={() => {
                    api.startGoogleSignIn();
                  }}
                >
                  <GoogleMark />
                  Continue with Google
                </button>

                <div className={styles.divider}>
                  <span>or</span>
                </div>
              </>
            )}

            <form onSubmit={handleSubmit} noValidate>
              <AnimatePresence initial={false}>
                {isSignUp && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.26, ease: [0.2, 0, 0.1, 1] }}
                    style={{ overflow: 'hidden' }}
                  >
                    <Field
                      id="name"
                      label="Your name"
                      inputRef={firstFieldRef}
                      value={name}
                      onChange={setName}
                      autoComplete="name"
                      placeholder="Alex Rivera"
                      error={error?.fieldError('name')}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <Field
                id="email"
                label="Email"
                type="email"
                inputRef={isSignUp ? undefined : firstFieldRef}
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder="you@company.com"
                error={error?.fieldError('email')}
              />

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label htmlFor="password">Password</label>
                  {!isSignUp && (
                    <a href="/reset-password" className={styles.forgot}>
                      Forgot?
                    </a>
                  )}
                </div>

                <div className={styles.inputWrap}>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    className={styles.input}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                    }}
                    autoComplete={isSignUp ? 'new-password' : 'current-password'}
                    placeholder={isSignUp ? 'At least 12 characters' : 'Your password'}
                    aria-describedby={isSignUp ? 'password-strength' : undefined}
                    aria-invalid={Boolean(error?.fieldError('password'))}
                  />
                  <button
                    type="button"
                    className={styles.reveal}
                    onClick={() => {
                      setShowPassword((v) => !v);
                    }}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                {error?.fieldError('password') && (
                  <p className={styles.fieldError}>{error.fieldError('password')}</p>
                )}

                {isSignUp && password.length > 0 && (
                  <div id="password-strength" className={styles.strength}>
                    <div className={styles.strengthBars}>
                      {[0, 1, 2, 3].map((i) => (
                        <motion.span
                          key={i}
                          className={styles.strengthBar}
                          data-filled={i < strength.score}
                          data-level={strength.score}
                          initial={false}
                          animate={{ scaleX: i < strength.score ? 1 : 0.35 }}
                          transition={{ duration: 0.26, ease: [0.34, 1.56, 0.64, 1] }}
                        />
                      ))}
                    </div>
                    <p className={styles.strengthText} data-level={strength.score}>
                      <strong>{strength.label}</strong> {strength.hint}
                    </p>
                  </div>
                )}
              </div>

              <button type="submit" className={styles.submit} disabled={busy}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={busy ? 'busy' : 'idle'}
                    className={styles.submitInner}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.16 }}
                  >
                    {busy ? (
                      <>
                        <Loader2 size={17} className={styles.spin} />
                        {isSignUp ? 'Creating your account' : 'Signing in'}
                      </>
                    ) : (
                      <>
                        {isSignUp ? 'Create account' : 'Sign in'}
                        <ArrowRight size={17} />
                      </>
                    )}
                  </motion.span>
                </AnimatePresence>
              </button>
            </form>

            <p className={styles.smallPrint}>
              {isSignUp ? (
                <>
                  By creating an account you agree to our <a href="/terms">terms</a> and{' '}
                  <a href="/privacy">privacy policy</a>.
                </>
              ) : (
                <>
                  New here?{' '}
                  <button
                    type="button"
                    className={styles.inlineLink}
                    onClick={() => {
                      switchMode('signup');
                    }}
                  >
                    Create an account
                  </button>
                </>
              )}
            </p>
          </motion.div>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field                                                               */
/* ------------------------------------------------------------------ */

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  error?: string | undefined;
  inputRef?: React.RefObject<HTMLInputElement | null> | undefined;
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  placeholder,
  error,
  inputRef,
}: FieldProps) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.inputWrap}>
        <input
          id={id}
          ref={inputRef}
          type={type}
          className={styles.input}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      {error && (
        <p id={`${id}-error`} className={styles.fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}

/** Google's mark, inlined so the button never waits on a network request. */
function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
