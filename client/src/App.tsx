import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sun, Moon, Sparkles, Users, Zap } from 'lucide-react';
import { series } from '@pulse/shared';
import styles from './App.module.css';

type Theme = 'dark' | 'light';

/** The demo result set, used until the live session wiring lands. */
const RESULTS = [
  { label: 'Unclear goals', value: 41 },
  { label: 'Too many tools', value: 27 },
  { label: 'Slow reviews', value: 21 },
  { label: 'Not enough time', value: 11 },
];

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return [theme, toggle];
}

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [responses, setResponses] = useState(0);

  // Simulates answers arriving so the motion is visible without a backend.
  useEffect(() => {
    const id = setInterval(() => {
      setResponses((n) => (n >= 184 ? 184 : n + Math.ceil(Math.random() * 7)));
    }, 260);
    return () => {
      clearInterval(id);
    };
  }, []);

  const max = Math.max(...RESULTS.map((r) => r.value));

  return (
    <div className={styles.page}>
      <button
        type="button"
        className={styles.themeToggle}
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            initial={{ opacity: 0, rotate: -90, scale: 0.6 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 90, scale: 0.6 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0.1, 1] }}
            className={styles.toggleIcon}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </motion.span>
        </AnimatePresence>
        {theme === 'dark' ? 'Light' : 'Dark'}
      </button>

      <main className={styles.shell}>
        <motion.header
          className={styles.hero}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0, 0, 0.2, 1] }}
        >
          <span className={styles.eyebrow}>
            <Sparkles size={13} />
            Design system, live
          </span>
          <h1 className={styles.title}>
            Built from <em>materials</em>,
            <br />
            not flat colour.
          </h1>
          <p className={styles.lede}>
            Every value on this page is generated from the token file. Glass with a rim highlight,
            gradients that rotate hue, and series colours computed to stay legible in both themes.
          </p>
        </motion.header>

        <section aria-labelledby="results-heading">
          <h2 id="results-heading" className={styles.sectionLabel}>
            Live results
          </h2>

          <div className={`glass ${styles.card}`}>
            <div className={styles.cardHead}>
              <p className={styles.question}>What is blocking us most?</p>
              <div className={styles.counter}>
                <Users size={15} />
                <span className="tabular">{responses}</span>
                <span className={styles.counterLabel}>answers</span>
              </div>
            </div>

            <ul className={styles.bars}>
              {RESULTS.map((r, i) => (
                <li key={r.label} className={styles.barRow}>
                  <span className={styles.barLabel}>{r.label}</span>
                  <div className={styles.barTrack}>
                    <motion.div
                      className={styles.barFill}
                      style={{
                        background: `var(--gradient-data-${String(i + 1)})`,
                        boxShadow: `var(--glow-data-${String(i + 1)})`,
                      }}
                      initial={{ width: 0, opacity: 0.3 }}
                      animate={{ width: `${String((r.value / max) * 100)}%`, opacity: 1 }}
                      transition={{
                        duration: 0.62,
                        delay: i * 0.038,
                        ease: [0.34, 1.56, 0.64, 1],
                      }}
                    />
                  </div>
                  <span className={`tabular ${styles.barValue}`}>{r.value}%</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="palette-heading">
          <h2 id="palette-heading" className={styles.sectionLabel}>
            Series palette
          </h2>
          <div className={styles.swatches}>
            {series.map((s, i) => (
              <motion.div
                key={s.name}
                className={styles.swatch}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.32, delay: i * 0.028, ease: [0, 0, 0.2, 1] }}
              >
                <div
                  className={styles.swatchChip}
                  style={{ background: `var(--gradient-data-${String(i + 1)})` }}
                />
                <div className={styles.swatchMeta}>
                  <strong>{s.name}</strong>
                  <span className="tabular">
                    {s.dark} / {s.light}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </section>

        <section aria-labelledby="stage-heading">
          <h2 id="stage-heading" className={styles.sectionLabel}>
            Presentation stage
          </h2>
          <div className={styles.stage}>
            <p className={styles.stageQuestion}>What is blocking us most?</p>
            <p className={`tabular ${styles.stageCode}`}>4 8 2 9 1 6</p>
          </div>
        </section>

        <hr className="hairline" />

        <section aria-labelledby="controls-heading">
          <h2 id="controls-heading" className={styles.sectionLabel}>
            Controls
          </h2>
          <div className={styles.buttons}>
            <motion.button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              whileHover={{ y: -2 }}
              whileTap={{ y: 0, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <Zap size={16} />
              Present
            </motion.button>
            <motion.button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              whileHover={{ y: -2 }}
              whileTap={{ y: 0, scale: 0.98 }}
              transition={{ duration: 0.14, ease: [0.34, 1.56, 0.64, 1] }}
            >
              Preview
            </motion.button>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`}>
              Cancel
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
