/**
 * The colour system.
 *
 * Flat hex values look like a wireframe. Premium interfaces are built from
 * *materials*: surfaces that catch light, accents that glow, gradients with
 * a hue shift across them rather than a straight interpolation through grey.
 *
 * So this file defines four things, not one:
 *
 *   1. Ramps    - full tonal scales, so every shade is available
 *   2. Gradients - multi-stop, hue-rotating, never two-stop-and-hope
 *   3. Materials - glass, glow, sheen; the things that make a surface feel real
 *   4. Auras     - large soft radial washes that give a page depth
 */

/* ------------------------------------------------------------------ */
/* 1. Tonal ramps                                                      */
/* ------------------------------------------------------------------ */

/**
 * The neutral ramp is deliberately *violet-shifted* in the shadows and
 * *warm-shifted* in the highlights. Pure grey reads as cheap; this reads
 * as ink on paper under a warm light.
 */
export const slate = {
  25: '#fcfcfd',
  50: '#f7f8fa',
  100: '#eef0f4',
  200: '#dfe2e9',
  300: '#c3c8d4',
  400: '#9aa1b2',
  500: '#6f7688',
  600: '#4e5567',
  700: '#373d4d',
  800: '#242938',
  900: '#171b28',
  950: '#0e111c',
  975: '#090b14',
  1000: '#05060d',
} as const;

/** The brand accent. An electric violet-indigo that survives a dim projector. */
export const iris = {
  50: '#eef0ff',
  100: '#e0e3ff',
  200: '#c6cbff',
  300: '#a3a8ff',
  400: '#8b84fc',
  500: '#7c5cf6',
  600: '#6d3fea',
  700: '#5d2fce',
  800: '#4d29a6',
  900: '#412783',
  950: '#28164f',
} as const;

/** Secondary accent, used for contrast against iris in duotone treatments. */
export const aqua = {
  50: '#ecfeff',
  100: '#cffafe',
  200: '#a5f3fc',
  300: '#67e8f9',
  400: '#22d3ee',
  500: '#06b6d4',
  600: '#0891b2',
  700: '#0e7490',
  800: '#155e75',
  900: '#164e63',
  950: '#083344',
} as const;

/** Warm accent, for energy moments: quiz reveals, celebrations, winners. */
export const ember = {
  50: '#fff7ed',
  100: '#ffedd5',
  200: '#fed7aa',
  300: '#fdba74',
  400: '#fb923c',
  500: '#f97316',
  600: '#ea580c',
  700: '#c2410c',
  800: '#9a3412',
  900: '#7c2d12',
  950: '#431407',
} as const;

export const jade = {
  400: '#34d399',
  500: '#10b981',
  600: '#059669',
  700: '#047857',
} as const;

export const rose = {
  400: '#fb7185',
  500: '#f43f5e',
  600: '#e11d48',
  700: '#be123c',
} as const;

export const amber = {
  400: '#fbbf24',
  500: '#f59e0b',
  600: '#d97706',
  700: '#b45309',
} as const;

/* ------------------------------------------------------------------ */
/* 2. Gradients                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every gradient here rotates hue as well as lightness. A two-stop gradient
 * between two shades of the same hue passes through grey in the middle and
 * looks muddy; adding a third stop at a neighbouring hue is what produces
 * that expensive, luminous look.
 */
export const gradients = {
  /** Primary buttons, the logo, anything that needs to feel alive. */
  iris: 'linear-gradient(135deg, #8b84fc 0%, #7c5cf6 45%, #6d3fea 100%)',

  /** Hero surfaces. Violet through blue into cyan. */
  aurora: 'linear-gradient(135deg, #7c5cf6 0%, #5b8def 40%, #22d3ee 100%)',

  /** Quiz reveal and celebration moments. */
  ember: 'linear-gradient(135deg, #fbbf24 0%, #f97316 50%, #ea580c 100%)',

  /** Correct answers, positive trend lines. */
  jade: 'linear-gradient(135deg, #6ee7b7 0%, #10b981 55%, #059669 100%)',

  /** Warnings and elimination moments. */
  rose: 'linear-gradient(135deg, #fda4af 0%, #f43f5e 55%, #be123c 100%)',

  /** The signature dark page wash. Not flat black — it has a violet core. */
  voidDark: 'radial-gradient(120% 100% at 50% 0%, #1a1533 0%, #0e111c 45%, #05060d 100%)',

  /** The light equivalent: warm paper, not clinical white. */
  voidLight: 'radial-gradient(120% 100% at 50% 0%, #ffffff 0%, #f7f8fa 45%, #eef0f4 100%)',

  /**
   * A hairline that fades out at both ends. Used for dividers that should
   * feel drawn rather than stamped.
   */
  hairlineDark:
    'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.10) 20%, rgba(255,255,255,0.10) 80%, transparent 100%)',
  hairlineLight:
    'linear-gradient(90deg, transparent 0%, rgba(5,6,13,0.10) 20%, rgba(5,6,13,0.10) 80%, transparent 100%)',

  /** Glass edge highlight — the bright top rim on a frosted card. */
  rimDark:
    'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.02) 40%, transparent 100%)',
  rimLight:
    'linear-gradient(180deg, rgba(255,255,255,0.90) 0%, rgba(255,255,255,0.30) 40%, transparent 100%)',

  /** Sweeping sheen used on loading skeletons and hover states. */
  sheen:
    'linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.10) 45%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.10) 55%, transparent 70%)',
} as const;

/* ------------------------------------------------------------------ */
/* 3. Materials                                                        */
/* ------------------------------------------------------------------ */

/**
 * Glass. The combination that actually looks like frosted glass rather than
 * a translucent rectangle: a blur, a slight saturation boost so colour
 * behind it stays vivid, a low-alpha fill, and a rim highlight on top.
 */
export const glass = {
  dark: {
    background: 'rgba(23, 27, 40, 0.62)',
    backdropFilter: 'blur(20px) saturate(1.6)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 1px 0 0 rgba(255,255,255,0.06) inset, 0 16px 40px -12px rgba(5,6,13,0.70)',
  },
  light: {
    background: 'rgba(255, 255, 255, 0.72)',
    backdropFilter: 'blur(20px) saturate(1.4)',
    border: '1px solid rgba(5, 6, 13, 0.06)',
    boxShadow: '0 1px 0 0 rgba(255,255,255,0.90) inset, 0 16px 40px -12px rgba(5,6,13,0.12)',
  },
} as const;

/**
 * Shadows tinted toward the accent rather than pure black. A black shadow on
 * a dark violet canvas reads as a grey smudge; a violet-tinted one reads as
 * depth.
 */
export const shadows = {
  dark: {
    xs: '0 1px 2px rgba(5, 6, 13, 0.40)',
    sm: '0 2px 6px -1px rgba(5, 6, 13, 0.50)',
    md: '0 8px 20px -6px rgba(5, 6, 13, 0.55), 0 2px 6px -2px rgba(5, 6, 13, 0.40)',
    lg: '0 20px 48px -12px rgba(5, 6, 13, 0.65), 0 6px 16px -6px rgba(5, 6, 13, 0.45)',
    xl: '0 32px 80px -20px rgba(5, 6, 13, 0.75), 0 10px 24px -8px rgba(5, 6, 13, 0.50)',
  },
  light: {
    xs: '0 1px 2px rgba(16, 20, 35, 0.05)',
    sm: '0 2px 6px -1px rgba(16, 20, 35, 0.08)',
    md: '0 8px 20px -6px rgba(16, 20, 35, 0.10), 0 2px 6px -2px rgba(16, 20, 35, 0.06)',
    lg: '0 20px 48px -12px rgba(16, 20, 35, 0.14), 0 6px 16px -6px rgba(16, 20, 35, 0.08)',
    xl: '0 32px 80px -20px rgba(16, 20, 35, 0.18), 0 10px 24px -8px rgba(16, 20, 35, 0.10)',
  },
} as const;

/**
 * Glows. What makes an accent feel lit rather than painted. Layered: a tight
 * ring for definition, a wide bloom for atmosphere.
 */
export const glows = {
  iris: '0 0 0 1px rgba(124, 92, 246, 0.40), 0 0 24px -4px rgba(124, 92, 246, 0.45), 0 0 64px -12px rgba(124, 92, 246, 0.30)',
  aqua: '0 0 0 1px rgba(34, 211, 238, 0.40), 0 0 24px -4px rgba(34, 211, 238, 0.45), 0 0 64px -12px rgba(34, 211, 238, 0.30)',
  ember:
    '0 0 0 1px rgba(249, 115, 22, 0.40), 0 0 24px -4px rgba(249, 115, 22, 0.50), 0 0 64px -12px rgba(249, 115, 22, 0.32)',
  jade: '0 0 0 1px rgba(16, 185, 129, 0.40), 0 0 24px -4px rgba(16, 185, 129, 0.45), 0 0 64px -12px rgba(16, 185, 129, 0.30)',
  /** Focus ring. Deliberately the most visible glow in the system. */
  focus: '0 0 0 2px rgba(5, 6, 13, 1), 0 0 0 4px rgba(139, 132, 252, 0.90)',
  focusLight: '0 0 0 2px #ffffff, 0 0 0 4px rgba(109, 63, 234, 0.85)',
} as const;

/* ------------------------------------------------------------------ */
/* 4. Auras                                                            */
/* ------------------------------------------------------------------ */

/**
 * Large, very soft radial washes positioned behind content. They are what
 * stop a dark page reading as a black rectangle. Used at low opacity,
 * usually two or three at once in different hues.
 */
export const auras = {
  irisTopLeft: 'radial-gradient(60% 50% at 15% 0%, rgba(124, 92, 246, 0.22) 0%, transparent 70%)',
  aquaTopRight: 'radial-gradient(50% 45% at 85% 5%, rgba(34, 211, 238, 0.16) 0%, transparent 70%)',
  emberBottom: 'radial-gradient(55% 45% at 50% 100%, rgba(249, 115, 22, 0.12) 0%, transparent 70%)',
  jadeBottomLeft:
    'radial-gradient(45% 40% at 10% 95%, rgba(16, 185, 129, 0.12) 0%, transparent 70%)',
} as const;

/** A ready-made stack for the main dark canvas. */
export const canvasAuraDark = [auras.irisTopLeft, auras.aquaTopRight, gradients.voidDark].join(
  ', ',
);

export const canvasAuraLight = [
  'radial-gradient(60% 50% at 15% 0%, rgba(124, 92, 246, 0.10) 0%, transparent 70%)',
  'radial-gradient(50% 45% at 85% 5%, rgba(34, 211, 238, 0.09) 0%, transparent 70%)',
  gradients.voidLight,
].join(', ');

/* ------------------------------------------------------------------ */
/* Chart palette                                                       */
/* ------------------------------------------------------------------ */

/**
 * Series colours, ordered so neighbours separate in both lightness and hue.
 * Each carries its own gradient, so a bar is never a flat block of colour.
 */
export interface SeriesColor {
  name: string;
  /** Bright tone, used on the dark canvas. */
  dark: string;
  /** Deep tone, used on the light canvas. */
  light: string;
  /** Gradient fill for the dark canvas. */
  darkGradient: string;
  /** Gradient fill for the light canvas. */
  lightGradient: string;
  /** Bloom used when this series is focused or winning. */
  glow: string;
}

/**
 * Series colours.
 *
 * Two things here are deliberate and were both forced by failing tests.
 *
 * First, each series carries a DIFFERENT TONE PER THEME. A single flat hex
 * cannot be readable on near-black and on near-white at once: bright enough
 * for one guarantees washed out on the other. Bars therefore swap tone with
 * the theme rather than keeping one colour and hoping.
 *
 * Second, the ORDER is computed, not chosen. It is the output of a search
 * that maximises contrast between neighbouring series in BOTH themes at
 * once, while keeping every colour legible against its own background, with
 * the brand colour pinned first. Three earlier hand-picked orderings failed
 * these constraints.
 */
const mk = (
  name: string,
  dark: string,
  light: string,
  darkFrom: string,
  darkTo: string,
  lightFrom: string,
  lightTo: string,
  glowRgb: string,
): SeriesColor => ({
  name,
  dark,
  light,
  darkGradient: `linear-gradient(135deg, ${darkFrom} 0%, ${darkTo} 100%)`,
  lightGradient: `linear-gradient(135deg, ${lightFrom} 0%, ${lightTo} 100%)`,
  glow: `0 0 24px -6px ${glowRgb}`,
});

export const series: SeriesColor[] = [
  mk(
    'iris',
    '#8b84fc',
    '#6d3fea',
    '#c6cbff',
    '#7c5cf6',
    '#8b84fc',
    '#5d2fce',
    'rgba(139,132,252,0.60)',
  ),
  mk(
    'lime',
    '#a3e635',
    '#3f6212',
    '#d9f99d',
    '#84cc16',
    '#84cc16',
    '#365314',
    'rgba(163,230,53,0.55)',
  ),
  mk(
    'pink',
    '#f472b6',
    '#db2777',
    '#fbcfe8',
    '#ec4899',
    '#f472b6',
    '#9d174d',
    'rgba(244,114,182,0.55)',
  ),
  mk(
    'jade',
    '#34d399',
    '#065f46',
    '#a7f3d0',
    '#10b981',
    '#34d399',
    '#064e3b',
    'rgba(52,211,153,0.55)',
  ),
  mk(
    'rose',
    '#fb7185',
    '#e11d48',
    '#fecdd3',
    '#f43f5e',
    '#fb7185',
    '#9f1239',
    'rgba(251,113,133,0.55)',
  ),
  mk(
    'teal',
    '#2dd4bf',
    '#115e59',
    '#99f6e4',
    '#14b8a6',
    '#2dd4bf',
    '#134e4a',
    'rgba(45,212,191,0.55)',
  ),
  mk(
    'fuchsia',
    '#e879f9',
    '#c026d3',
    '#f5d0fe',
    '#d946ef',
    '#e879f9',
    '#86198f',
    'rgba(232,121,249,0.55)',
  ),
  mk(
    'amber',
    '#fbbf24',
    '#92400e',
    '#fde68a',
    '#f59e0b',
    '#fbbf24',
    '#78350f',
    'rgba(251,191,36,0.55)',
  ),
  mk(
    'violet',
    '#c084fc',
    '#9333ea',
    '#e9d5ff',
    '#a855f7',
    '#c084fc',
    '#6b21a8',
    'rgba(192,132,252,0.55)',
  ),
  mk(
    'ember',
    '#fb923c',
    '#9a3412',
    '#fed7aa',
    '#f97316',
    '#fb923c',
    '#7c2d12',
    'rgba(251,146,60,0.55)',
  ),
  mk(
    'indigo',
    '#818cf8',
    '#4f46e5',
    '#c7d2fe',
    '#6366f1',
    '#818cf8',
    '#3730a3',
    'rgba(129,140,248,0.55)',
  ),
  mk(
    'sky',
    '#38bdf8',
    '#075985',
    '#bae6fd',
    '#0ea5e9',
    '#38bdf8',
    '#0c4a6e',
    'rgba(56,189,248,0.55)',
  ),
];

/** Flat dark-theme values, for code that only needs one hex. */
export const seriesSolids: string[] = series.map((s) => s.dark);

/** Flat light-theme values. */
export const seriesSolidsLight: string[] = series.map((s) => s.light);
