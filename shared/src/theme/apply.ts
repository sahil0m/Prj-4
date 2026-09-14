import { bestTextOn, contrastRatio, CONTRAST } from './contrast.js';

/**
 * A deck's theme, as both apps apply it.
 *
 * The presenter used to apply the accent alone, and the join app applied
 * nothing at all -- so a deck styled in the editor looked like the default
 * on a phone, which is the screen most of the room is looking at.
 *
 * The values are plain CSS custom properties. Every component already reads
 * these, so applying a theme is setting variables on one element rather
 * than teaching anything about themes.
 */

export interface DeckThemeLike {
  preset?: string;
  accent?: string;
  background?: string;
  fontFamily?: string;
  logoUrl?: string;
  mode?: 'dark' | 'light';
}

/**
 * Text that can be read on a given background.
 *
 * The product's own ink is a near-black rather than pure black, which looks
 * better and is fine on the palettes it ships with. On a mid-tone an author
 * picks -- indigo, say -- it lands just under the AA threshold, at 4.48.
 * Rather than accept text that is nearly readable, this falls back to pure
 * black or white, which buys the last of the contrast back.
 */
function readableInk(background: string): string {
  const branded = bestTextOn(background);
  if (contrastRatio(branded, background) >= CONTRAST.aaBody) return branded;

  return bestTextOn(background, ['#ffffff', '#000000']);
}

/** Hex, rgb() or a named colour -- anything the browser would accept. */
function usable(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The CSS variables for a theme.
 *
 * Returns an empty object for an absent theme, so a caller can spread it
 * unconditionally.
 */
export function themeStyle(theme: DeckThemeLike | null | undefined): Record<string, string> {
  if (!theme) return {};

  const style: Record<string, string> = {};

  if (usable(theme.accent)) {
    const accent = theme.accent.trim();
    style['--color-accent'] = accent;
    style['--accent-gradient'] =
      `linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 55%, #000))`;
    style['--accent-glow'] = `0 8px 28px color-mix(in srgb, ${accent} 35%, transparent)`;
    // Text drawn on the accent itself: black or white, whichever can
    // actually be read on that colour.
    style['--color-on-accent'] = bestTextOn(accent);
  }

  if (usable(theme.background)) {
    const background = theme.background.trim();
    const ink = readableInk(background);

    style['--color-canvas'] = background;
    // The default canvas is a gradient image painted over the colour, so a
    // chosen background would otherwise be hidden behind it.
    style['--canvas-image'] = 'none';
    // Panels lift slightly off the page rather than being a fixed grey that
    // might vanish against a custom background.
    style['--color-surface'] = `color-mix(in srgb, ${ink} 6%, ${background})`;
    style['--color-surface-raised'] = `color-mix(in srgb, ${ink} 10%, ${background})`;
    style['--color-border'] = `color-mix(in srgb, ${ink} 18%, ${background})`;
    style['--color-ink'] = ink;
    style['--color-ink-muted'] = `color-mix(in srgb, ${ink} 72%, ${background})`;
    style['--color-ink-subtle'] = `color-mix(in srgb, ${ink} 52%, ${background})`;
  }

  if (usable(theme.fontFamily)) {
    // Quoted so a family with spaces survives, with the stack behind it in
    // case the name is not installed on this machine.
    style['--font-sans'] =
      `"${theme.fontFamily.trim().replace(/"/g, '')}", Inter, system-ui, sans-serif`;
  }

  return style;
}

/**
 * Which base palette a theme wants, for the `data-theme` attribute.
 *
 * Separate from the variables because it is an attribute rather than a
 * style, and because a custom background overrides the palette anyway.
 */
export function themeMode(theme: DeckThemeLike | null | undefined): 'dark' | 'light' {
  return theme?.mode === 'light' ? 'light' : 'dark';
}

/**
 * The part of an element this needs.
 *
 * Described structurally rather than as an HTMLElement, because this
 * package is also compiled for the server, which has no DOM types. A real
 * element satisfies it; nothing here has to know that.
 */
export interface StyleTarget {
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => string;
    getPropertyValue: (name: string) => string;
  };
  dataset: Record<string, string | undefined>;
}

/**
 * Applies a theme to the page itself, and returns how to undo it.
 *
 * On the root rather than on a container, because the page background is
 * painted on `body` from variables defined at the root. Set on a container,
 * a light deck leaves the edges of a phone dark wherever the container does
 * not reach -- under the notch, and while a scroll bounces past the end.
 *
 * The caller decides when a theme stops applying (leaving a session, or
 * closing the presenter), so this hands back a function that puts every
 * property back exactly as it found it.
 */
export function applyTheme(root: StyleTarget, theme: DeckThemeLike | null | undefined): () => void {
  const style = themeStyle(theme);
  const previousMode = root.dataset.theme;

  const previous = new Map<string, string>();
  for (const name of Object.keys(style)) {
    previous.set(name, root.style.getPropertyValue(name));
  }

  for (const [name, value] of Object.entries(style)) {
    root.style.setProperty(name, value);
  }

  if (theme) root.dataset.theme = themeMode(theme);

  return () => {
    for (const [name, value] of previous) {
      if (value === '') root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }

    if (previousMode === undefined) delete root.dataset.theme;
    else root.dataset.theme = previousMode;
  };
}
