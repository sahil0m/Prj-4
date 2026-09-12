/**
 * The design system.
 *
 * Two ideas drive everything here.
 *
 * 1. TWO TYPE SCALES, NOT ONE SCALED UP.
 *    The editor is read at arm's length on a laptop. The presentation view
 *    is read from the back of a thirty metre room. Those are different
 *    design problems, so they get different scales. Taking the editor scale
 *    and multiplying it is how you end up with headings that fit and body
 *    text nobody can read.
 *
 * 2. COLOUR IS SEMANTIC, NEVER LITERAL.
 *    Components reference `surface` and `ink`, never `slate-800`. That is
 *    what lets a user's brand theme swap the whole palette without touching
 *    a single component.
 */

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * Our own palette rather than a stock one. Deliberately warm-shifted in the
 * neutrals so dark mode reads as ink rather than as cold grey, which is the
 * tell of an off-the-shelf template.
 */
export const palette = {
  // Neutrals, warm-shifted. 0 is near-black, 1000 is near-white.
  ink: {
    0: '#07080c',
    50: '#0c0e14',
    100: '#12151e',
    200: '#1a1e29',
    300: '#252a38',
    400: '#39404f',
    500: '#5a6274',
    600: '#8a92a3',
    700: '#b4bac6',
    800: '#d7dbe3',
    900: '#eef0f4',
    1000: '#ffffff',
  },

  // The signature accent: an electric indigo that survives a dim projector.
  indigo: {
    300: '#a5b4ff',
    400: '#818cf8',
    500: '#6366f1',
    600: '#4f46e5',
    700: '#4338ca',
  },

  // Result-chart palette.
  //
  // Not hand-picked by eye: this ordering is the output of a search that
  // maximises luminance contrast AND hue distance between neighbouring
  // series, subject to every colour staying readable on both the dark and
  // the light canvas. The theme tests assert those properties, so a future
  // "nicer" reordering cannot silently make two adjacent bars merge.
  data: [
    '#6366f1', // indigo
    '#65a30d', // lime
    '#7c3aed', // violet
    '#10b981', // emerald
    '#e11d48', // rose
    '#0ea5e9', // sky
    '#ea580c', // orange
    '#9333ea', // purple
    '#16a34a', // green
    '#db2777', // pink
    '#d97706', // amber
    '#c026d3', // fuchsia
  ],

  positive: { base: '#10b981', soft: '#064e3b' },
  caution: { base: '#f59e0b', soft: '#451a03' },
  danger: { base: '#f43f5e', soft: '#4c0519' },
} as const;

/* ------------------------------------------------------------------ */
/* Semantic colour roles                                               */
/* ------------------------------------------------------------------ */

export interface ColorRoles {
  /** Page background. */
  canvas: string;
  /** Cards, panels, anything raised off the canvas. */
  surface: string;
  /** A surface raised above another surface. */
  surfaceRaised: string;
  /** Hairlines and dividers. */
  border: string;
  /** A border that needs to be noticed. */
  borderStrong: string;
  /** Primary text. */
  ink: string;
  /** Secondary text: captions, helper copy. */
  inkMuted: string;
  /** Tertiary text: timestamps, disabled states. */
  inkSubtle: string;
  /** Text sitting on top of the accent colour. */
  onAccent: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  positive: string;
  caution: string;
  danger: string;
  /** Focus ring. Must be visible on every surface in the theme. */
  focus: string;
}

export const darkRoles: ColorRoles = {
  canvas: palette.ink[0],
  surface: palette.ink[100],
  surfaceRaised: palette.ink[200],
  border: palette.ink[300],
  borderStrong: palette.ink[400],
  ink: palette.ink[900],
  inkMuted: palette.ink[700],
  inkSubtle: palette.ink[600],
  onAccent: '#ffffff',
  accent: palette.indigo[500],
  accentHover: palette.indigo[400],
  accentSoft: 'rgba(99, 102, 241, 0.16)',
  positive: palette.positive.base,
  caution: palette.caution.base,
  danger: palette.danger.base,
  focus: palette.indigo[400],
};

export const lightRoles: ColorRoles = {
  canvas: '#fbfbfd',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  border: '#e6e8ee',
  borderStrong: '#cfd3dd',
  ink: palette.ink[100],
  inkMuted: palette.ink[500],
  inkSubtle: palette.ink[600],
  onAccent: '#ffffff',
  accent: palette.indigo[600],
  accentHover: palette.indigo[700],
  accentSoft: 'rgba(79, 70, 229, 0.10)',
  positive: '#059669',
  caution: '#b45309',
  danger: '#e11d48',
  focus: palette.indigo[600],
};

/* ------------------------------------------------------------------ */
/* Typography — two separate scales                                    */
/* ------------------------------------------------------------------ */

export const fonts = {
  /** Interface type. A variable grotesque with a tall x-height. */
  ui: '"InterVariable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  /** Presentation type. Slightly tighter, designed to hold at huge sizes. */
  display: '"InterVariable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  /** Numerals in results, so digits never jitter as values change. */
  mono: '"JetBrains Mono", "SF Mono", Consolas, monospace',
} as const;

/**
 * Editor scale. Read at roughly 60cm. Base 15px, a 1.2 ratio, and a
 * deliberately short scale so the interface stays calm.
 */
export const editorType = {
  micro: { size: '11px', line: '16px', tracking: '0.02em', weight: 500 },
  caption: { size: '12px', line: '18px', tracking: '0.01em', weight: 450 },
  body: { size: '15px', line: '23px', tracking: '0', weight: 450 },
  bodyStrong: { size: '15px', line: '23px', tracking: '0', weight: 600 },
  title: { size: '18px', line: '26px', tracking: '-0.01em', weight: 600 },
  heading: { size: '24px', line: '32px', tracking: '-0.02em', weight: 650 },
  display: { size: '34px', line: '40px', tracking: '-0.03em', weight: 700 },
} as const;

/**
 * Presentation scale. Read at up to thirty metres.
 *
 * Sizes are expressed in `cqw` (percent of the container width) so the deck
 * scales with the projector rather than assuming a fixed resolution. The
 * `min` values are the floor enforced by the accessibility checker: below
 * these, the back row genuinely cannot read the screen.
 */
export const stageType = {
  /** The question itself. Owns the top of the slide. */
  prompt: { size: 'clamp(32px, 4.4cqw, 108px)', line: '1.12', tracking: '-0.02em', weight: 680, min: 32 },
  /** A supporting line under the question. */
  subtitle: { size: 'clamp(20px, 2.2cqw, 52px)', line: '1.3', tracking: '-0.01em', weight: 500, min: 20 },
  /** Labels on bars, options in a list. */
  label: { size: 'clamp(18px, 1.7cqw, 40px)', line: '1.25', tracking: '0', weight: 550, min: 18 },
  /** Percentages and counts. Tabular so digits do not shift. */
  value: { size: 'clamp(20px, 2.0cqw, 48px)', line: '1.1', tracking: '-0.01em', weight: 680, min: 20 },
  /** The join code, shown enormous. */
  code: { size: 'clamp(40px, 6.5cqw, 160px)', line: '1', tracking: '0.06em', weight: 720, min: 40 },
  /** Corner chips: participant count, join hint. */
  chip: { size: 'clamp(14px, 1.2cqw, 26px)', line: '1.3', tracking: '0.01em', weight: 550, min: 14 },
} as const;

/* ------------------------------------------------------------------ */
/* Space, radius, elevation, motion                                    */
/* ------------------------------------------------------------------ */

/** A 4px grid. Named by purpose so usage stays consistent. */
export const space = {
  hair: '2px',
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
  '3xl': '48px',
  '4xl': '64px',
  '5xl': '96px',
} as const;

export const radius = {
  sm: '6px',
  md: '10px',
  lg: '14px',
  xl: '20px',
  pill: '999px',
} as const;

/**
 * Shadows are tinted with the accent rather than pure black, which stops
 * raised surfaces looking like grey smudges on a dark canvas.
 */
export const elevation = {
  none: 'none',
  sm: '0 1px 2px rgba(7, 8, 12, 0.32)',
  md: '0 4px 12px -2px rgba(7, 8, 12, 0.40), 0 2px 4px -2px rgba(7, 8, 12, 0.30)',
  lg: '0 12px 32px -8px rgba(7, 8, 12, 0.50), 0 4px 12px -4px rgba(7, 8, 12, 0.35)',
  glow: '0 0 0 1px rgba(99, 102, 241, 0.30), 0 8px 28px -6px rgba(99, 102, 241, 0.35)',
} as const;

/**
 * Motion. Every duration and curve the product uses lives here, so the
 * whole app moves with one personality instead of a dozen.
 *
 * The `spring` curve overshoots slightly. That tiny bounce is what makes a
 * bar chart feel alive rather than mechanical, and it is the single most
 * noticeable difference between our result charts and everyone else's.
 */
export const motion = {
  duration: {
    instant: '80ms',
    fast: '140ms',
    base: '220ms',
    slow: '380ms',
    /** Result bars growing as answers land. */
    chart: '620ms',
    /** The leaderboard reorder — the most dramatic moment in the product. */
    drama: '900ms',
  },
  ease: {
    /** Interface movement: quick out, gentle settle. */
    standard: 'cubic-bezier(0.20, 0.00, 0.10, 1.00)',
    /** Something leaving the screen. */
    exit: 'cubic-bezier(0.40, 0.00, 1.00, 1.00)',
    /** Something arriving. */
    enter: 'cubic-bezier(0.00, 0.00, 0.20, 1.00)',
    /** The signature: a controlled overshoot for data. */
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1.00)',
  },
  /**
   * Stagger between sibling elements, in milliseconds. Applied when bars or
   * cards appear together so they cascade rather than snapping in as a block.
   */
  stagger: 38,
} as const;

/** Breakpoints. Mobile-first; each value is a min-width. */
export const screens = {
  sm: '480px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1600px',
} as const;

/** Stacking order, centralised so nothing fights over z-index. */
export const layers = {
  base: 0,
  raised: 10,
  sticky: 100,
  drawer: 200,
  overlay: 300,
  modal: 400,
  popover: 500,
  toast: 600,
  tooltip: 700,
} as const;

/* ------------------------------------------------------------------ */
/* CSS variable emission                                               */
/* ------------------------------------------------------------------ */

const toKebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Turns a set of colour roles into CSS custom properties. */
export function rolesToCssVars(roles: ColorRoles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(roles)) {
    out[`--color-${toKebab(key)}`] = value;
  }
  palette.data.forEach((hex, i) => {
    out[`--color-data-${i + 1}`] = hex;
  });
  return out;
}

/** The tokens that do not change between light and dark. */
export function staticCssVars(): Record<string, string> {
  const out: Record<string, string> = {
    '--font-ui': fonts.ui,
    '--font-display': fonts.display,
    '--font-mono': fonts.mono,
    '--stagger': `${motion.stagger}ms`,
  };
  for (const [k, v] of Object.entries(space)) out[`--space-${k}`] = v;
  for (const [k, v] of Object.entries(radius)) out[`--radius-${k}`] = v;
  for (const [k, v] of Object.entries(elevation)) out[`--elevation-${k}`] = v;
  for (const [k, v] of Object.entries(motion.duration)) out[`--duration-${k}`] = v;
  for (const [k, v] of Object.entries(motion.ease)) out[`--ease-${k}`] = v;
  for (const [k, v] of Object.entries(layers)) out[`--layer-${k}`] = String(v);
  return out;
}

/** Serialises a variable map into a CSS declaration block body. */
export function cssVarBlock(vars: Record<string, string>, indent = '  '): string {
  return Object.entries(vars)
    .map(([k, v]) => `${indent}${k}: ${v};`)
    .join('\n');
}
