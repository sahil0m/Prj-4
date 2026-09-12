import { describe, it, expect } from 'vitest';
import { ALL_DEFINITIONS, SLIDE_REGISTRY } from './registry.js';
import { validateSlideReady, isSlideReady, validateDeckReady } from './readiness.js';
import type { SlideConfig } from './configs.js';

describe('slide readiness', () => {
  it('handles every slide kind without throwing', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(() => validateSlideReady(def.defaults())).not.toThrow();
    }
  });

  it('flags a fresh multiple choice as not ready (no prompt written yet)', () => {
    const cfg = { ...SLIDE_REGISTRY.multiple_choice.defaults(), prompt: '' };
    const issues = validateSlideReady(cfg);
    expect(issues.some((i) => i.field === 'prompt' && i.level === 'error')).toBe(true);
    expect(isSlideReady(cfg)).toBe(false);
  });

  it('accepts a properly filled multiple choice', () => {
    const cfg = SLIDE_REGISTRY.multiple_choice.defaults();
    expect(isSlideReady(cfg)).toBe(true);
  });

  it('requires a correct answer on a quiz', () => {
    const base = SLIDE_REGISTRY.quiz_select.defaults();
    if (base.kind !== 'quiz_select') throw new Error('wrong kind');
    const stripped: SlideConfig = {
      ...base,
      options: base.options.map((o) => ({ ...o, correct: false })),
    };
    const issues = validateSlideReady(stripped);
    expect(issues.some((i) => i.message.includes('correct answer'))).toBe(true);
  });

  it('requires an image on a pin-on-image slide', () => {
    const cfg = SLIDE_REGISTRY.pin_image.defaults();
    expect(isSlideReady(cfg)).toBe(false);
    expect(validateSlideReady(cfg).some((i) => i.field === 'imageUrl')).toBe(true);
  });

  it('warns, but does not block, when an image has no description', () => {
    const base = SLIDE_REGISTRY.image.defaults();
    if (base.kind !== 'image') throw new Error('wrong kind');
    const cfg: SlideConfig = { ...base, imageUrl: 'https://example.com/a.png', alt: '' };
    const issues = validateSlideReady(cfg);
    expect(issues.some((i) => i.field === 'alt' && i.level === 'warning')).toBe(true);
    expect(isSlideReady(cfg)).toBe(true);
  });

  it('spots duplicate option labels as a warning', () => {
    const base = SLIDE_REGISTRY.multiple_choice.defaults();
    if (base.kind !== 'multiple_choice') throw new Error('wrong kind');
    const cfg: SlideConfig = {
      ...base,
      options: [
        { id: 'a', label: 'Yes' },
        { id: 'b', label: 'yes' },
      ],
    };
    const issues = validateSlideReady(cfg);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('Yes'))).toBe(true);
  });

  it('rejects a compare slide pointing at the same slide twice', () => {
    const base = SLIDE_REGISTRY.compare.defaults();
    if (base.kind !== 'compare') throw new Error('wrong kind');
    const cfg: SlideConfig = { ...base, slideIdA: 's1', slideIdB: 's1' };
    expect(validateSlideReady(cfg).some((i) => i.message.includes('two different'))).toBe(true);
  });

  it('rejects a scale whose max is below its min', () => {
    const base = SLIDE_REGISTRY.scales.defaults();
    if (base.kind !== 'scales') throw new Error('wrong kind');
    const cfg: SlideConfig = { ...base, min: 5, max: 2 };
    expect(validateSlideReady(cfg).some((i) => i.field === 'max')).toBe(true);
  });

  describe('deck level', () => {
    it('ignores skipped slides', () => {
      const broken = { ...SLIDE_REGISTRY.pin_image.defaults(), skipped: true } as SlideConfig;
      const result = validateDeckReady([{ id: 's1', config: broken }]);
      expect(result.ready).toBe(true);
      expect(result.errorCount).toBe(0);
    });

    it('reports each unfinished slide by id', () => {
      const result = validateDeckReady([
        { id: 'good', config: SLIDE_REGISTRY.multiple_choice.defaults() },
        { id: 'bad', config: SLIDE_REGISTRY.pin_image.defaults() },
      ]);
      expect(result.ready).toBe(false);
      expect(Object.keys(result.bySlide)).toEqual(['bad']);
      expect(result.errorCount).toBeGreaterThan(0);
    });

    it('is ready when the whole deck is filled in', () => {
      const result = validateDeckReady([
        { id: 'a', config: SLIDE_REGISTRY.multiple_choice.defaults() },
        { id: 'b', config: SLIDE_REGISTRY.word_cloud.defaults() },
        { id: 'c', config: SLIDE_REGISTRY.heading.defaults() },
      ]);
      expect(result.ready).toBe(true);
    });
  });
});
