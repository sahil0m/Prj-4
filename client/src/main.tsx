import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import './styles/theme.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing from index.html');

/*
 * Movement, once, for the whole app.
 *
 * The stylesheet already collapses CSS animations when the system asks for
 * reduced motion, but most of the movement here is Motion's, which runs in
 * JavaScript and never sees that rule. Fourteen files animate; without
 * this, someone who has asked their operating system to stop animations
 * still got flying reactions and springing leaderboard rows.
 *
 * "user" follows the system setting rather than forcing a choice, and
 * Motion keeps transforms that carry meaning -- opacity and layout still
 * settle -- so nothing snaps to a half-drawn state.
 */
createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
