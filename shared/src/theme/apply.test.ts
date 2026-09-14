import { describe, it, expect } from 'vitest';
import { themeStyle, themeMode, applyTheme, type StyleTarget } from './apply.js';
import { contrastRatio } from './contrast.js';

describe('themeStyle', () => {
  it('is empty for a deck with no theme', () => {
    expect(themeStyle(null)).toEqual({});
    expect(themeStyle(undefined)).toEqual({});
    expect(themeStyle({})).toEqual({});
  });

  it('ignores blank values rather than writing empty variables', () => {
    // A cleared colour field must fall back to the default palette, not
    // paint the page with an empty string.
    expect(themeStyle({ accent: '   ', background: '' })).toEqual({});
  });

  it('applies the accent and what sits on it', () => {
    const style = themeStyle({ accent: '#ff7a1a' });
    expect(style['--color-accent']).toBe('#ff7a1a');
    expect(style['--accent-gradient']).toContain('#ff7a1a');
  });

  /*
   * The part that matters most: an author can pick any background, and the
   * text on it has to stay readable. Choosing the wrong one turns a deck
   * into a blank wall from the back of a room.
   */
  it('picks text that can actually be read on the chosen background', () => {
    for (const background of ['#ffffff', '#fff8f0', '#07080c', '#2b2b2b', '#6366f1']) {
      const ink = themeStyle({ background })['--color-ink'];
      expect(ink, background).toBeDefined();
      expect(contrastRatio(ink!, background), `${background} with ${ink!}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('turns off the default canvas image when a background is chosen', () => {
    // The default canvas paints a gradient over the colour, which would
    // hide the author's background entirely.
    expect(themeStyle({ background: '#fff8f0' })['--canvas-image']).toBe('none');
  });

  it('keeps a font name with spaces usable, with a stack behind it', () => {
    const family = themeStyle({ fontFamily: 'Playfair Display' })['--font-sans'];
    expect(family).toContain('"Playfair Display"');
    expect(family).toContain('system-ui');
  });

  it('cannot be made to inject through a font name', () => {
    const family = themeStyle({ fontFamily: 'Evil"; background: url(x)' })['--font-sans'];
    expect(family).not.toContain('"; background');
  });
});

describe('themeMode', () => {
  it('is dark unless the deck asks for light', () => {
    expect(themeMode(null)).toBe('dark');
    expect(themeMode({ mode: 'dark' })).toBe('dark');
    expect(themeMode({ mode: 'light' })).toBe('light');
  });
});

describe('applyTheme', () => {
  /** Enough of an element for this to work on, without a DOM. */
  function fakeRoot(): StyleTarget & { properties: Map<string, string> } {
    const properties = new Map<string, string>();

    return {
      properties,
      dataset: {},
      style: {
        setProperty: (name, value) => properties.set(name, value),
        removeProperty: (name) => {
          const previous = properties.get(name) ?? '';
          properties.delete(name);
          return previous;
        },
        getPropertyValue: (name) => properties.get(name) ?? '',
      },
    };
  }

  it('sets the variables and the mode on the page', () => {
    const root = fakeRoot();
    applyTheme(root, { accent: '#ff7a1a', mode: 'light' });

    expect(root.properties.get('--color-accent')).toBe('#ff7a1a');
    expect(root.dataset.theme).toBe('light');
  });

  it('puts the page back exactly as it was', () => {
    // Leaving a session must not leave the rest of the app wearing that
    // deck's colours.
    const root = fakeRoot();
    root.style.setProperty('--color-accent', '#6366f1');
    root.dataset.theme = 'dark';

    const undo = applyTheme(root, { accent: '#ff7a1a', background: '#fff8f0', mode: 'light' });
    expect(root.properties.get('--color-accent')).toBe('#ff7a1a');

    undo();

    expect(root.properties.get('--color-accent')).toBe('#6366f1');
    expect(root.properties.has('--color-canvas')).toBe(false);
    expect(root.dataset.theme).toBe('dark');
  });

  it('leaves a page with no theme of its own untouched', () => {
    const root = fakeRoot();
    const undo = applyTheme(root, null);
    undo();

    expect(root.properties.size).toBe(0);
    expect(root.dataset.theme).toBeUndefined();
  });
});
