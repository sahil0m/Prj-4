import { describe, it, expect } from 'vitest';
import { parseJson, evenSample, toSlideConfig } from './features.js';
import { SLIDE_REGISTRY } from '@pulse/shared';

/**
 * A model's output is the least predictable input this system takes. These
 * cover the shapes real models actually produce — fences, preamble, trailing
 * prose — because failing the whole request over formatting would make the
 * feature unreliable in front of a room.
 */
describe('parseJson', () => {
  it('reads plain JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON wrapped in a markdown fence', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads a fence with no language tag', () => {
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('digs the object out of surrounding prose', () => {
    expect(parseJson('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseJson('\n\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('handles nested objects and arrays', () => {
    const text = '{"slides":[{"kind":"word_cloud","prompt":"Hi"}]}';
    expect(parseJson(text)).toEqual({ slides: [{ kind: 'word_cloud', prompt: 'Hi' }] });
  });

  it('throws on text with no JSON at all', () => {
    expect(() => parseJson('I cannot help with that.')).toThrow();
  });

  it('throws rather than returning half an object', () => {
    expect(() => parseJson('{"a": 1')).toThrow();
  });
});

describe('evenSample', () => {
  it('returns everything when under the limit', () => {
    expect(evenSample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('caps at the limit', () => {
    expect(
      evenSample(
        Array.from({ length: 500 }, (_, i) => i),
        100,
      ),
    ).toHaveLength(100);
  });

  it('spreads across the list rather than taking the first N', () => {
    // A late surge of one opinion must still be represented, so the sample
    // has to reach the end of the list.
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sample = evenSample(items, 10);
    expect(sample[0]).toBe(0);
    expect(sample[sample.length - 1]).toBeGreaterThan(800);
  });

  it('handles an empty list', () => {
    expect(evenSample([], 10)).toEqual([]);
  });
});

describe('toSlideConfig', () => {
  it('builds a valid multiple choice slide', () => {
    const { kind, config } = toSlideConfig({
      kind: 'multiple_choice',
      prompt: 'Tea or coffee?',
      options: ['Tea', 'Coffee'],
    });

    expect(kind).toBe('multiple_choice');
    const parsed = SLIDE_REGISTRY.multiple_choice.configSchema.safeParse(config);
    expect(parsed.success, 'generated config must pass its own schema').toBe(true);
    expect((config as { options: { label: string }[] }).options.map((o) => o.label)).toEqual([
      'Tea',
      'Coffee',
    ]);
  });

  it('marks the correct answer on a quiz slide', () => {
    const { config } = toSlideConfig({
      kind: 'quiz_select',
      prompt: 'Capital of France?',
      options: ['Rome', 'Paris', 'Madrid'],
      correctIndex: 1,
    });

    const options = (config as { options: { label: string; correct?: boolean }[] }).options;
    expect(options[1]?.correct).toBe(true);
    expect(options[0]?.correct).toBe(false);
  });

  it('defaults to the first option when no correct index is given', () => {
    const { config } = toSlideConfig({
      kind: 'quiz_select',
      prompt: 'Pick one',
      options: ['A', 'B'],
    });
    const options = (config as { options: { correct?: boolean }[] }).options;
    expect(options[0]?.correct).toBe(true);
  });

  it('ignores options on a kind that has none', () => {
    const { config } = toSlideConfig({
      kind: 'word_cloud',
      prompt: 'One word?',
      options: ['should', 'be', 'ignored'],
    });
    expect('options' in (config as object)).toBe(false);
    expect(SLIDE_REGISTRY.word_cloud.configSchema.safeParse(config).success).toBe(true);
  });

  it('falls back to defaults rather than emitting an invalid slide', () => {
    // One option is below the schema's minimum of two; the result must still
    // be a slide the editor can open, not a broken one.
    const { config } = toSlideConfig({
      kind: 'multiple_choice',
      prompt: 'Only one option',
      options: ['Alone'],
    });
    expect(SLIDE_REGISTRY.multiple_choice.configSchema.safeParse(config).success).toBe(true);
  });

  it('builds statements for a scales slide', () => {
    const { config } = toSlideConfig({
      kind: 'scales',
      prompt: 'Rate these',
      statements: ['Clear', 'Useful'],
    });
    const statements = (config as { statements: { label: string }[] }).statements;
    expect(statements.map((s) => s.label)).toEqual(['Clear', 'Useful']);
  });

  it('builds items for a ranking slide', () => {
    const { config } = toSlideConfig({
      kind: 'ranking',
      prompt: 'Order these',
      items: ['First', 'Second', 'Third'],
    });
    const items = (config as { items: { label: string }[] }).items;
    expect(items).toHaveLength(3);
  });

  it('keeps every generated kind valid against its own schema', () => {
    const kinds = [
      'word_cloud',
      'open_text',
      'true_false',
      'nps',
      'star_rating',
      'heading',
    ] as const;

    for (const kind of kinds) {
      const { config } = toSlideConfig({ kind, prompt: 'A question' });
      expect(
        SLIDE_REGISTRY[kind].configSchema.safeParse(config).success,
        `${kind} produced an invalid config`,
      ).toBe(true);
    }
  });
});
