import {
  darkRoles,
  lightRoles,
  darkMaterials,
  lightMaterials,
  rolesToCssVars,
  staticCssVars,
  editorType,
  stageType,
} from './tokens.js';

/**
 * Generates the root stylesheet from the design tokens.
 *
 * The point is that there is exactly one source of truth. The app does not
 * restate colours in CSS; it consumes variables emitted from the same token
 * file the tests assert against. A palette change cannot drift out of sync
 * with the styles, because the styles are derived.
 */

const block = (selector: string, vars: Record<string, string>): string =>
  [`${selector} {`, ...Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`), '}'].join('\n');

/** Emits the type scale as variables, so components never hard-code sizes. */
function typeVars(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, t] of Object.entries(editorType)) {
    out[`--text-${name}-size`] = t.size;
    out[`--text-${name}-line`] = t.line;
    out[`--text-${name}-tracking`] = t.tracking;
    out[`--text-${name}-weight`] = String(t.weight);
  }
  for (const [name, t] of Object.entries(stageType)) {
    out[`--stage-${name}-size`] = t.size;
    out[`--stage-${name}-line`] = t.line;
    out[`--stage-${name}-tracking`] = t.tracking;
    out[`--stage-${name}-weight`] = String(t.weight);
  }
  return out;
}

export function generateStylesheet(): string {
  return `/*
 * GENERATED FILE — do not edit.
 *
 * Produced from shared/src/theme by \`npm run theme:build\`.
 * Change the tokens, not this file.
 */

${block(':root, [data-theme="dark"]', {
  ...rolesToCssVars(darkRoles, darkMaterials),
  ...staticCssVars(),
  ...typeVars(),
})}

${block('[data-theme="light"]', rolesToCssVars(lightRoles, lightMaterials))}

/* Follow the operating system when the user has not chosen explicitly. */
@media (prefers-color-scheme: light) {
${block('  :root:not([data-theme])', rolesToCssVars(lightRoles, lightMaterials))
  .split('\n')
  .map((l) => (l.startsWith('  :root') || l === '}' ? `  ${l.trim()}` : `  ${l}`))
  .join('\n')}
}

/* ------------------------------------------------------------------ */
/* Base                                                                */
/* ------------------------------------------------------------------ */

*,
*::before,
*::after {
  box-sizing: border-box;
}

* {
  margin: 0;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  font-family: var(--font-ui);
  font-size: var(--text-body-size);
  line-height: var(--text-body-line);
  font-weight: var(--text-body-weight);
  color: var(--color-ink);
  background: var(--canvas-image);
  background-attachment: fixed;
  min-height: 100dvh;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

img,
picture,
video,
canvas,
svg {
  display: block;
  max-width: 100%;
}

input,
button,
textarea,
select {
  font: inherit;
  color: inherit;
}

button {
  background: none;
  border: none;
  cursor: pointer;
}

h1,
h2,
h3,
h4,
p {
  overflow-wrap: break-word;
}

/* ------------------------------------------------------------------ */
/* Focus                                                               */
/* ------------------------------------------------------------------ */

/*
 * Focus is never removed, only restyled. A keyboard user who cannot see
 * where they are is locked out of the product.
 */
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--radius-sm);
}

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

/*
 * Honour the system preference. Movement becomes instant rather than
 * disabled, so nothing jumps to a broken-looking state.
 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

/* Frosted panel. The ::before rim is what sells it as glass. */
.glass {
  position: relative;
  overflow: hidden;
  background: var(--glass-background);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  box-shadow: var(--glass-shadow);
  border-radius: var(--radius-xl);
}

.glass::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 72px;
  background: var(--rim);
  pointer-events: none;
}

/* A divider that fades at both ends rather than stopping abruptly. */
.hairline {
  height: 1px;
  border: 0;
  background: var(--hairline);
}

/* Text filled with a gradient. */
.gradient-text {
  background: var(--gradient-iris);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* Loading shimmer. */
@keyframes sheen {
  from {
    background-position: -200% 0;
  }
  to {
    background-position: 200% 0;
  }
}

.skeleton {
  background:
    var(--gradient-sheen),
    color-mix(in srgb, var(--color-ink) 8%, transparent);
  background-size: 200% 100%;
  animation: sheen 1.6s var(--ease-standard) infinite;
  border-radius: var(--radius-md);
}

/* Bars and cards entering together cascade rather than snapping in. */
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.rise {
  animation: rise var(--duration-base) var(--ease-enter) both;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/* Visible to screen readers, invisible on screen. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* Numerals that do not shift width as values change. */
.tabular {
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
}
`;
}
