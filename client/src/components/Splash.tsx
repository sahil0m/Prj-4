import { motion } from 'motion/react';
import { Radio } from 'lucide-react';
import styles from './Splash.module.css';

/**
 * Shown while the session is being restored. Deliberately calm: a spinner
 * that appears for 150ms and vanishes reads as a glitch, so this fades in
 * slowly enough that a fast check shows almost nothing.
 */
export function Splash({ message }: { message?: string }) {
  return (
    <div className={styles.splash}>
      <motion.div
        className={styles.inner}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.25 }}
      >
        <motion.span
          className={styles.mark}
          animate={{ scale: [1, 1.08, 1], opacity: [0.75, 1, 0.75] }}
          transition={{ duration: 1.9, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden="true"
        >
          <Radio size={22} />
        </motion.span>
        {message && <p className={styles.message}>{message}</p>}
      </motion.div>
      <span className="sr-only" role="status">
        {message ?? 'Loading'}
      </span>
    </div>
  );
}
