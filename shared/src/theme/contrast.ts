/**
 * Colour contrast, implemented rather than aspired to.
 *
 * Two places rely on this:
 *   - the accessibility checker in the editor, which warns an author before
 *     they present something the back row cannot read
 *   - the theme tests, which fail the build if our own palette regresses
 *
 * Thresholds follow WCAG 2.1. We hold presentation text to the stricter AAA
 * bar because a projector in a lit room is a far worse viewing condition
 * than a laptop screen.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses #rgb, #rrggbb, rgb() and rgba(). Returns null if unrecognised. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    // Expand the three-digit form (#abc -> #aabbcc) so both paths share
    // one slice-based read. Avoids indexing into a possibly-short string.
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  return null;
}

/** Relative luminance, per the WCAG definition. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return 0;
  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

export const CONTRAST = {
  /** Body text, WCAG AA. */
  aaBody: 4.5,
  /** Large text (>=24px, or >=18.66px bold), WCAG AA. */
  aaLarge: 3,
  /** Body text, WCAG AAA. */
  aaaBody: 7,
  /** Large text, WCAG AAA. */
  aaaLarge: 4.5,
  /** Interface components and graphics, WCAG AA. */
  uiComponent: 3,
  /**
   * Our own bar for anything shown on a projector. Higher than AA because a
   * lit room and a cheap projector both wash out contrast badly.
   */
  stage: 4.5,
} as const;

export type ContrastVerdict = 'fail' | 'aa' | 'aaa';

export function verdictFor(ratio: number, isLargeText: boolean): ContrastVerdict {
  const aa = isLargeText ? CONTRAST.aaLarge : CONTRAST.aaBody;
  const aaa = isLargeText ? CONTRAST.aaaLarge : CONTRAST.aaaBody;
  if (ratio >= aaa) return 'aaa';
  if (ratio >= aa) return 'aa';
  return 'fail';
}

export interface ContrastCheck {
  ratio: number;
  verdict: ContrastVerdict;
  passes: boolean;
  /** Plain-English explanation, shown directly to the author. */
  advice: string;
}

/**
 * Checks a foreground against a background and explains the result in
 * language an author can act on.
 */
export function checkContrast(
  foreground: string,
  background: string,
  options: { largeText?: boolean; forStage?: boolean } = {},
): ContrastCheck {
  const { largeText = false, forStage = false } = options;
  const ratio = contrastRatio(foreground, background);
  const rounded = Math.round(ratio * 100) / 100;

  const required = forStage ? CONTRAST.stage : largeText ? CONTRAST.aaLarge : CONTRAST.aaBody;
  const passes = ratio >= required;
  const verdict = verdictFor(ratio, largeText);

  let advice: string;
  if (ratio === 0) {
    advice = 'One of these colours could not be read.';
  } else if (passes && verdict === 'aaa') {
    advice = 'Excellent contrast. Readable in any room.';
  } else if (passes) {
    advice = 'Good contrast. Readable on a projector.';
  } else if (ratio >= 3) {
    advice = forStage
      ? 'Too faint for a big screen. The back of the room will struggle.'
      : 'Too faint for small text. Darken the text or lighten the background.';
  } else {
    advice = 'Very hard to read. Pick a much darker or much lighter colour.';
  }

  return { ratio: rounded, verdict, passes, advice };
}

/**
 * Picks whichever of two candidates reads better on the given background.
 * Used to decide black-or-white label text on top of a chart colour.
 */
export function bestTextOn(
  background: string,
  candidates: [string, string] = ['#ffffff', '#07080c'],
): string {
  const [a, b] = candidates;
  return contrastRatio(a, background) >= contrastRatio(b, background) ? a : b;
}
