import { describe, it, expect } from 'vitest';
import {
  palette,
  series,
  darkRoles,
  lightRoles,
  stageType,
  editorType,
  rolesToCssVars,
  staticCssVars,
  motion,
  type ColorRoles,
} from './tokens.js';
import {
  contrastRatio,
  checkContrast,
  parseColor,
  bestTextOn,
  verdictFor,
  CONTRAST,
} from './contrast.js';

describe('contrast maths', () => {
  it('parses every colour format we use', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#07080c')).toEqual({ r: 7, g: 8, b: 12 });
    expect(parseColor('rgb(99, 102, 241)')).toEqual({ r: 99, g: 102, b: 241 });
    expect(parseColor('rgba(99, 102, 241, 0.5)')).toEqual({ r: 99, g: 102, b: 241 });
  });

  it('returns null for anything it cannot read', () => {
    expect(parseColor('rebeccapurple')).toBeNull();
    expect(parseColor('#gg0000')).toBeNull();
    expect(parseColor('')).toBeNull();
  });

  it('matches the known reference ratios', () => {
    // Black on white is the maximum possible ratio.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    // A colour against itself is the minimum.
    expect(contrastRatio('#6366f1', '#6366f1')).toBeCloseTo(1, 2);
  });

  it('is symmetric — order of arguments does not matter', () => {
    const a = contrastRatio('#6366f1', '#07080c');
    const b = contrastRatio('#07080c', '#6366f1');
    expect(a).toBeCloseTo(b, 5);
  });

  it('grades against the right WCAG threshold for the text size', () => {
    expect(verdictFor(8, false)).toBe('aaa');
    expect(verdictFor(5, false)).toBe('aa');
    expect(verdictFor(3.5, false)).toBe('fail');
    // The same 3.5 passes when the text is large.
    expect(verdictFor(3.5, true)).toBe('aa');
  });

  it('gives advice an author can act on', () => {
    const bad = checkContrast('#555555', '#5a5a5a');
    expect(bad.passes).toBe(false);
    expect(bad.advice.length).toBeGreaterThan(10);
    expect(bad.advice).not.toMatch(/undefined|NaN/);
  });

  it('picks readable label text over any chart colour', () => {
    for (const hex of palette.data) {
      const chosen = bestTextOn(hex);
      expect(contrastRatio(chosen, hex)).toBeGreaterThanOrEqual(3);
    }
  });
});

/* ------------------------------------------------------------------ */

/** Every text role that must be legible, per theme. */
const textRoles: [keyof ColorRoles, number, string][] = [
  ['ink', CONTRAST.aaBody, 'primary text'],
  ['inkMuted', CONTRAST.aaBody, 'secondary text'],
  ['inkSubtle', CONTRAST.aaLarge, 'tertiary text'],
];

describe.each([
  ['dark', darkRoles],
  ['light', lightRoles],
] as const)('%s theme is readable', (name, roles) => {
  it.each(textRoles)('%s meets its threshold on the canvas', (role, threshold) => {
    const ratio = contrastRatio(roles[role], roles.canvas);
    expect(ratio, `${name}.${role} on canvas is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      threshold,
    );
  });

  it.each(textRoles)('%s meets its threshold on a surface', (role, threshold) => {
    const ratio = contrastRatio(roles[role], roles.surface);
    expect(ratio, `${name}.${role} on surface is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      threshold,
    );
  });

  it('text on the accent colour is readable', () => {
    const ratio = contrastRatio(roles.onAccent, roles.accent);
    expect(ratio, `${name} onAccent is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      CONTRAST.aaLarge,
    );
  });

  it('the focus ring is visible against the canvas', () => {
    const ratio = contrastRatio(roles.focus, roles.canvas);
    expect(ratio, `${name} focus ring is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
      CONTRAST.uiComponent,
    );
  });

  it('borders are visible against their surface', () => {
    const ratio = contrastRatio(roles.borderStrong, roles.surface);
    expect(ratio, `${name} borderStrong is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1.4);
  });

  it('status colours are readable on the canvas', () => {
    for (const role of ['positive', 'caution', 'danger'] as const) {
      const ratio = contrastRatio(roles[role], roles.canvas);
      expect(ratio, `${name}.${role} is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
        CONTRAST.aaLarge,
      );
    }
  });

  it('defines every role with a real colour', () => {
    for (const key of Object.keys(roles) as (keyof ColorRoles)[]) {
      const value = roles[key];
      expect(parseColor(value), `${name}.${key} = "${value}"`).not.toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */

describe('chart palette', () => {
  it('every dark-theme tone is readable on the dark canvas', () => {
    for (const s of series) {
      const ratio = contrastRatio(s.dark, darkRoles.canvas);
      expect(ratio, `${s.name} (${s.dark}) is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('every light-theme tone is readable on the light canvas', () => {
    for (const s of series) {
      const ratio = contrastRatio(s.light, lightRoles.canvas);
      expect(ratio, `${s.name} (${s.light}) is ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('adjacent series separate on the dark canvas', () => {
    // Neighbouring bars sit side by side and must not read as one block.
    for (let i = 1; i < series.length; i += 1) {
      const ratio = contrastRatio(series[i - 1]!.dark, series[i]!.dark);
      const label = `${series[i - 1]!.name} vs ${series[i]!.name}`;
      expect(ratio, `${label} is ${ratio.toFixed(2)}`).toBeGreaterThan(1.15);
    }
  });

  it('adjacent series separate on the light canvas', () => {
    for (let i = 1; i < series.length; i += 1) {
      const ratio = contrastRatio(series[i - 1]!.light, series[i]!.light);
      const label = `${series[i - 1]!.name} vs ${series[i]!.name}`;
      expect(ratio, `${label} is ${ratio.toFixed(2)}`).toBeGreaterThan(1.15);
    }
  });

  it('gives every series a gradient and a glow for both themes', () => {
    for (const s of series) {
      expect(s.darkGradient, s.name).toMatch(/linear-gradient/);
      expect(s.lightGradient, s.name).toMatch(/linear-gradient/);
      expect(s.glow, s.name).toMatch(/rgba/);
    }
  });

  it('has no duplicate colours', () => {
    expect(new Set(palette.data).size).toBe(palette.data.length);
  });

  it('offers enough series for the widest slide we allow', () => {
    // Multiple choice caps at 20 options, but charts recycle the palette
    // past 12. Twelve distinct colours is the practical readable limit.
    expect(palette.data.length).toBeGreaterThanOrEqual(12);
  });
});

/* ------------------------------------------------------------------ */

describe('typography', () => {
  it('keeps the editor and stage scales genuinely separate', () => {
    // If someone ever "simplifies" this by scaling one from the other, the
    // back row stops being able to read the screen. This test is the guard.
    const editorBase = parseInt(editorType.body.size, 10);
    expect(editorBase).toBeLessThan(20);
    expect(stageType.prompt.min).toBeGreaterThanOrEqual(32);
    expect(stageType.label.min).toBeGreaterThanOrEqual(18);
  });

  it('every stage role scales with the container', () => {
    for (const [name, token] of Object.entries(stageType)) {
      expect(token.size, `${name} must be fluid`).toMatch(/clamp\(/);
      expect(token.size, `${name} must scale with container width`).toMatch(/cqw/);
    }
  });

  it('every stage role declares a readable floor', () => {
    for (const [name, token] of Object.entries(stageType)) {
      expect(token.min, `${name} min`).toBeGreaterThanOrEqual(14);
    }
  });

  it('orders the editor scale from smallest to largest', () => {
    const sizes = [
      editorType.micro,
      editorType.caption,
      editorType.body,
      editorType.title,
      editorType.heading,
      editorType.display,
    ].map((t) => parseInt(t.size, 10));
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]!, `step ${i}`).toBeGreaterThanOrEqual(sizes[i - 1]!);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('motion', () => {
  it('gives data movement more time than interface movement', () => {
    const ms = (v: string) => parseInt(v, 10);
    expect(ms(motion.duration.chart)).toBeGreaterThan(ms(motion.duration.base));
    expect(ms(motion.duration.drama)).toBeGreaterThan(ms(motion.duration.chart));
  });

  it('keeps interface movement below the threshold where it feels sluggish', () => {
    expect(parseInt(motion.duration.base, 10)).toBeLessThanOrEqual(250);
    expect(parseInt(motion.duration.fast, 10)).toBeLessThanOrEqual(150);
  });

  it('uses an overshooting curve for the signature spring', () => {
    // The third control point above 1 is what produces the bounce.
    const match = /cubic-bezier\(([^)]+)\)/.exec(motion.ease.spring);
    expect(match).not.toBeNull();
    const values = match![1]!.split(',').map((n) => Number(n.trim()));
    expect(values[1]!).toBeGreaterThan(1);
  });

  it('staggers siblings slowly enough to read, fast enough not to drag', () => {
    expect(motion.stagger).toBeGreaterThanOrEqual(20);
    expect(motion.stagger).toBeLessThanOrEqual(60);
  });
});

/* ------------------------------------------------------------------ */

describe('css variable emission', () => {
  it('emits a variable for every colour role', () => {
    const vars = rolesToCssVars(darkRoles);
    for (const key of Object.keys(darkRoles)) {
      const kebab = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      expect(vars[`--color-${kebab}`], key).toBeDefined();
    }
  });

  it('emits one variable per chart series', () => {
    const vars = rolesToCssVars(darkRoles);
    for (let i = 1; i <= palette.data.length; i += 1) {
      expect(vars[`--color-data-${i}`]).toBeDefined();
    }
  });

  it('emits the same variable names for both themes, so swapping works', () => {
    const dark = Object.keys(rolesToCssVars(darkRoles)).sort();
    const light = Object.keys(rolesToCssVars(lightRoles)).sort();
    expect(dark).toEqual(light);
  });

  it('emits spacing, radius, motion and layer tokens', () => {
    const vars = staticCssVars();
    expect(vars['--space-lg']).toBe('16px');
    expect(vars['--radius-pill']).toBe('999px');
    expect(vars['--duration-chart']).toBeDefined();
    expect(vars['--ease-spring']).toBeDefined();
    expect(vars['--layer-modal']).toBeDefined();
  });

  it('produces valid custom property names throughout', () => {
    const all = { ...rolesToCssVars(darkRoles), ...staticCssVars() };
    for (const key of Object.keys(all)) {
      expect(key, key).toMatch(/^--[a-z0-9-]+$/);
    }
  });
});
