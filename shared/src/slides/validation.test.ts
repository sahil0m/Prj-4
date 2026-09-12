import { describe, it, expect } from 'vitest';
import { zSlideConfig } from './configs.js';
import { zAnswer } from './answers.js';
import { SLIDE_REGISTRY, ALL_DEFINITIONS } from './registry.js';
import { SLIDE_KINDS } from './kinds.js';

/**
 * Adversarial tests. Every one of these represents something a malicious or
 * buggy client could actually send. The schemas are the last line of defence
 * before data reaches the database, so they must reject all of it.
 */

describe('config schemas reject hostile input', () => {
  it('rejects an unknown slide kind', () => {
    expect(zSlideConfig.safeParse({ kind: 'exec_shell', prompt: 'hi' }).success).toBe(false);
  });

  it('rejects a missing kind', () => {
    expect(zSlideConfig.safeParse({ prompt: 'hi' }).success).toBe(false);
  });

  it('rejects a prompt longer than the limit', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), prompt: 'x'.repeat(501) };
    expect(zSlideConfig.safeParse(cfg).success).toBe(false);
  });

  it('accepts a prompt exactly at the limit', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), prompt: 'x'.repeat(500) };
    expect(zSlideConfig.safeParse(cfg).success).toBe(true);
  });

  it('rejects more options than allowed', () => {
    const base = SLIDE_REGISTRY.multiple_choice.defaults();
    if (base.kind !== 'multiple_choice') throw new Error('wrong kind');
    const cfg = {
      ...base,
      options: Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
    };
    expect(zSlideConfig.safeParse(cfg).success).toBe(false);
  });

  it('rejects fewer options than allowed', () => {
    const base = SLIDE_REGISTRY.multiple_choice.defaults();
    if (base.kind !== 'multiple_choice') throw new Error('wrong kind');
    expect(zSlideConfig.safeParse({ ...base, options: [{ id: 'o1', label: 'Only one' }] }).success).toBe(
      false,
    );
  });

  it('rejects script-bearing and non-web url schemes in an image slide', () => {
    const base = SLIDE_REGISTRY.image.defaults();
    const hostile = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'not a url',
      '//evil.com',
    ];
    for (const bad of hostile) {
      expect(zSlideConfig.safeParse({ ...base, imageUrl: bad }).success, bad).toBe(false);
    }
  });

  it('accepts ordinary http and https image urls', () => {
    const base = SLIDE_REGISTRY.image.defaults();
    for (const good of ['https://example.com/a.png', 'http://example.com/b.jpg']) {
      expect(zSlideConfig.safeParse({ ...base, imageUrl: good }).success, good).toBe(true);
    }
  });

  it('allows an empty url while the author is still working', () => {
    const base = SLIDE_REGISTRY.image.defaults();
    expect(zSlideConfig.safeParse({ ...base, imageUrl: '' }).success).toBe(true);
  });

  it('rejects a negative timer', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), timerSeconds: -1 };
    expect(zSlideConfig.safeParse(cfg).success).toBe(false);
  });

  it('rejects a non-integer timer', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), timerSeconds: 1.5 };
    expect(zSlideConfig.safeParse(cfg).success).toBe(false);
  });

  it('rejects a malformed hex colour on a drawing slide', () => {
    const base = SLIDE_REGISTRY.drawing.defaults();
    for (const bad of ['red', '#ff', '#gggggg', 'rgb(1,2,3)', '#12345']) {
      expect(zSlideConfig.safeParse({ ...base, strokeColors: [bad] }).success, bad).toBe(false);
    }
  });

  it('accepts a well-formed hex colour', () => {
    const base = SLIDE_REGISTRY.drawing.defaults();
    expect(zSlideConfig.safeParse({ ...base, strokeColors: ['#A1b2C3'] }).success).toBe(true);
  });

  it('rejects out-of-range map coordinates', () => {
    const base = SLIDE_REGISTRY.map_pin.defaults();
    expect(zSlideConfig.safeParse({ ...base, centerLat: 91 }).success).toBe(false);
    expect(zSlideConfig.safeParse({ ...base, centerLat: -91 }).success).toBe(false);
    expect(zSlideConfig.safeParse({ ...base, centerLng: 181 }).success).toBe(false);
  });

  it('accepts coordinates exactly at the poles and date line', () => {
    const base = SLIDE_REGISTRY.map_pin.defaults();
    expect(zSlideConfig.safeParse({ ...base, centerLat: 90, centerLng: 180 }).success).toBe(true);
    expect(zSlideConfig.safeParse({ ...base, centerLat: -90, centerLng: -180 }).success).toBe(true);
  });

  it('strips unknown properties rather than storing them', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), isAdmin: true, __proto__: { evil: 1 } };
    const parsed = zSlideConfig.parse(cfg);
    expect('isAdmin' in parsed).toBe(false);
  });

  it('keeps unicode, emoji and right-to-left text intact', () => {
    for (const text of ['مرحبا بالعالم', '你好世界', 'Привет мир', '🎉 party 🎊', 'é']) {
      const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), prompt: text };
      const parsed = zSlideConfig.parse(cfg);
      expect(parsed.prompt, text).toBe(text);
    }
  });

  it('does not treat html or sql as special — it is stored verbatim', () => {
    // Escaping belongs at the render boundary, not the storage boundary.
    const nasty = '<script>alert(1)</script>';
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), prompt: nasty };
    expect(zSlideConfig.parse(cfg).prompt).toBe(nasty);
  });

  it('trims surrounding whitespace from a prompt', () => {
    const cfg = { ...SLIDE_REGISTRY.word_cloud.defaults(), prompt: '   spaced   ' };
    expect(zSlideConfig.parse(cfg).prompt).toBe('spaced');
  });
});

describe('answer schemas reject hostile input', () => {
  it('rejects an unknown answer kind', () => {
    expect(zAnswer.safeParse({ kind: 'drop_tables', text: 'x' }).success).toBe(false);
  });

  it('rejects an empty open text answer', () => {
    expect(zAnswer.safeParse({ kind: 'open_text', text: '' }).success).toBe(false);
    expect(zAnswer.safeParse({ kind: 'open_text', text: '   ' }).success).toBe(false);
  });

  it('rejects an over-long open text answer', () => {
    expect(zAnswer.safeParse({ kind: 'open_text', text: 'x'.repeat(1001) }).success).toBe(false);
  });

  it('accepts an open text answer at exactly the limit', () => {
    expect(zAnswer.safeParse({ kind: 'open_text', text: 'x'.repeat(1000) }).success).toBe(true);
  });

  it('rejects an empty choice selection', () => {
    expect(zAnswer.safeParse({ kind: 'multiple_choice', optionIds: [] }).success).toBe(false);
  });

  it('rejects a flood of selections', () => {
    const optionIds = Array.from({ length: 100 }, (_, i) => `o${i}`);
    expect(zAnswer.safeParse({ kind: 'multiple_choice', optionIds }).success).toBe(false);
  });

  it('rejects pin coordinates outside the image', () => {
    expect(zAnswer.safeParse({ kind: 'pin_image', pins: [{ x: 1.5, y: 0.5 }] }).success).toBe(false);
    expect(zAnswer.safeParse({ kind: 'pin_image', pins: [{ x: -0.1, y: 0.5 }] }).success).toBe(false);
  });

  it('accepts pins exactly on the image edge', () => {
    expect(zAnswer.safeParse({ kind: 'pin_image', pins: [{ x: 0, y: 1 }] }).success).toBe(true);
  });

  it('rejects a negative elapsed time on a quiz answer', () => {
    expect(
      zAnswer.safeParse({ kind: 'quiz_select', optionIds: ['o1'], elapsedMs: -1 }).success,
    ).toBe(false);
  });

  it('rejects an absurd elapsed time on a quiz answer', () => {
    expect(
      zAnswer.safeParse({ kind: 'quiz_select', optionIds: ['o1'], elapsedMs: 999_999_999 }).success,
    ).toBe(false);
  });

  it('rejects a drawing with too many points in one stroke', () => {
    const points = Array.from({ length: 4001 }, () => 0.5);
    expect(
      zAnswer.safeParse({ kind: 'drawing', strokes: [{ color: '#000000', width: 1, points }] })
        .success,
    ).toBe(false);
  });

  it('rejects a drawing stroke with an odd number of coordinates', () => {
    // Points are a flat list of x,y pairs. An odd count is malformed and
    // would make the renderer read past the end of the array.
    expect(
      zAnswer.safeParse({
        kind: 'drawing',
        strokes: [{ color: '#000000', width: 1, points: [0.1, 0.2, 0.3, 0.4, 0.5] }],
      }).success,
    ).toBe(false);
  });

  it('accepts a drawing stroke with paired coordinates', () => {
    expect(
      zAnswer.safeParse({
        kind: 'drawing',
        strokes: [{ color: '#000000', width: 1, points: [0.1, 0.2, 0.3, 0.4] }],
      }).success,
    ).toBe(true);
  });

  it('rejects NaN and Infinity in a numeric answer', () => {
    expect(zAnswer.safeParse({ kind: 'guess_number', value: NaN }).success).toBe(false);
    expect(zAnswer.safeParse({ kind: 'guess_number', value: Infinity }).success).toBe(false);
  });

  it('rejects an out-of-range NPS score', () => {
    expect(zAnswer.safeParse({ kind: 'nps', score: 11 }).success).toBe(false);
    expect(zAnswer.safeParse({ kind: 'nps', score: -1 }).success).toBe(false);
  });

  it('accepts NPS scores at both ends', () => {
    expect(zAnswer.safeParse({ kind: 'nps', score: 0 }).success).toBe(true);
    expect(zAnswer.safeParse({ kind: 'nps', score: 10 }).success).toBe(true);
  });

  it('rejects a word cloud answer with no words', () => {
    expect(zAnswer.safeParse({ kind: 'word_cloud', words: [] }).success).toBe(false);
  });

  it('rejects a word cloud answer that floods entries', () => {
    const words = Array.from({ length: 11 }, (_, i) => `w${i}`);
    expect(zAnswer.safeParse({ kind: 'word_cloud', words }).success).toBe(false);
  });
});

describe('every slide kind is fully wired', () => {
  it.each(SLIDE_KINDS)('%s has a complete registry entry', (kind) => {
    const def = SLIDE_REGISTRY[kind];
    expect(def.kind).toBe(kind);
    expect(def.label.trim().length).toBeGreaterThan(0);
    expect(def.blurb.trim().length).toBeGreaterThan(0);
    expect(def.icon.trim().length).toBeGreaterThan(0);
    expect(def.configSchema).toBeDefined();

    const defaults = def.defaults();
    expect(defaults.kind).toBe(kind);
    expect(def.configSchema.safeParse(defaults).success).toBe(true);
    expect(zSlideConfig.safeParse(defaults).success).toBe(true);
  });

  it('defaults are independent between calls', () => {
    // A shared array across instances would mean editing one slide silently
    // edits every other slide of the same kind.
    const a = SLIDE_REGISTRY.multiple_choice.defaults();
    const b = SLIDE_REGISTRY.multiple_choice.defaults();
    if (a.kind !== 'multiple_choice' || b.kind !== 'multiple_choice') throw new Error('wrong kind');
    a.options.push({ id: 'injected', label: 'Injected' });
    expect(b.options).toHaveLength(3);
  });

  it('every kind belongs to a known family', () => {
    const families = new Set(ALL_DEFINITIONS.map((d) => d.family));
    expect(families.size).toBeGreaterThan(0);
    for (const d of ALL_DEFINITIONS) {
      expect(typeof d.family).toBe('string');
      expect(d.family.length).toBeGreaterThan(0);
    }
  });
});
