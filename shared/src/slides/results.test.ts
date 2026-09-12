import { describe, it, expect } from 'vitest';
import { aggregate, type AnswerRow, type LabelSource } from './results.js';
import { SLIDE_KINDS } from './kinds.js';

/** Builds answer rows without repeating the id plumbing in every test. */
function rows(...payloads: unknown[]): AnswerRow[] {
  return payloads.map((payload, i) => ({ id: `r${String(i)}`, payload }));
}

const options: LabelSource = {
  options: [
    { id: 'a', label: 'Tea' },
    { id: 'b', label: 'Coffee' },
    { id: 'c', label: 'Neither' },
  ],
};

describe('aggregate', () => {
  /* ---------------- resilience ---------------- */

  it('returns an empty tally rather than throwing when there are no answers', () => {
    for (const kind of SLIDE_KINDS) {
      expect(() => aggregate(kind, [], {})).not.toThrow();
    }
  });

  it('survives malformed payloads', () => {
    // One bad row must never break the results a room is watching.
    const junk = rows(null, undefined, 'a string', 42, [], { nonsense: true });
    for (const kind of SLIDE_KINDS) {
      expect(() => aggregate(kind, junk, options)).not.toThrow();
    }
  });

  it('ignores non-finite numbers', () => {
    const result = aggregate(
      'guess_number',
      rows(
        { value: 10 },
        { value: Number.NaN },
        { value: Number.POSITIVE_INFINITY },
        { value: 20 },
      ),
      { min: 0, max: 100 },
    );
    expect(result.type).toBe('numeric');
    if (result.type !== 'numeric') return;
    expect(result.summary.count).toBe(2);
    expect(result.summary.average).toBe(15);
  });

  /* ---------------- choice ---------------- */

  it('counts votes and percentages', () => {
    const result = aggregate(
      'multiple_choice',
      rows({ optionIds: ['a'] }, { optionIds: ['a'] }, { optionIds: ['b'] }, { optionIds: ['a'] }),
      options,
    );

    expect(result.type).toBe('counts');
    if (result.type !== 'counts') return;

    expect(result.totalVotes).toBe(4);
    expect(result.items.map((i) => i.count)).toEqual([3, 1, 0]);
    expect(result.items[0]?.percent).toBe(75);
    expect(result.items[1]?.percent).toBe(25);
    expect(result.items[2]?.percent).toBe(0);
  });

  it('keeps options in their defined order, not by popularity', () => {
    // The room reads the chart against the slide; reordering would confuse.
    const result = aggregate('multiple_choice', rows({ optionIds: ['c'] }), options);
    if (result.type !== 'counts') throw new Error('wrong type');
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts every pick when several are allowed', () => {
    const result = aggregate('multiple_choice', rows({ optionIds: ['a', 'b'] }), options);
    if (result.type !== 'counts') throw new Error('wrong type');
    expect(result.totalVotes).toBe(2);
    expect(result.items[0]?.percent).toBe(50);
  });

  it('carries the correct flag through for quiz slides', () => {
    const result = aggregate('quiz_select', rows({ optionIds: ['a'] }), {
      options: [
        { id: 'a', label: 'Right', correct: true },
        { id: 'b', label: 'Wrong', correct: false },
      ],
    });
    if (result.type !== 'counts') throw new Error('wrong type');
    expect(result.items[0]?.correct).toBe(true);
    expect(result.items[1]?.correct).toBe(false);
  });

  it('labels true and false without needing config', () => {
    const result = aggregate(
      'true_false',
      rows({ value: true }, { value: false }, { value: true }),
      {},
    );
    if (result.type !== 'counts') throw new Error('wrong type');
    expect(result.items[0]?.label).toBe('True');
    expect(result.items[0]?.count).toBe(2);
    expect(result.items[1]?.count).toBe(1);
  });

  /* ---------------- word cloud ---------------- */

  it('groups words case-insensitively but shows the first spelling', () => {
    const result = aggregate(
      'word_cloud',
      rows({ words: ['React'] }, { words: ['react'] }, { words: ['REACT'] }, { words: ['Vue'] }),
      {},
    );
    if (result.type !== 'words') throw new Error('wrong type');
    expect(result.words[0]).toEqual({ word: 'React', count: 3 });
    expect(result.words[1]).toEqual({ word: 'Vue', count: 1 });
  });

  it('sorts words by count, then alphabetically for a stable chart', () => {
    const result = aggregate('word_cloud', rows({ words: ['b'] }, { words: ['a'] }), {});
    if (result.type !== 'words') throw new Error('wrong type');
    expect(result.words.map((w) => w.word)).toEqual(['a', 'b']);
  });

  it('drops blank words', () => {
    const result = aggregate('word_cloud', rows({ words: ['  ', '', 'real'] }), {});
    if (result.type !== 'words') throw new Error('wrong type');
    expect(result.words).toHaveLength(1);
  });

  /* ---------------- open text ---------------- */

  it('sorts text answers by upvotes', () => {
    const result = aggregate(
      'open_text',
      [
        { id: 'r1', payload: { text: 'quiet' }, upvotes: 1 },
        { id: 'r2', payload: { text: 'popular' }, upvotes: 9 },
      ],
      {},
    );
    if (result.type !== 'texts') throw new Error('wrong type');
    expect(result.entries[0]?.text).toBe('popular');
  });

  /* ---------------- numeric ---------------- */

  it('summarises numbers', () => {
    const result = aggregate(
      'guess_number',
      rows({ value: 10 }, { value: 20 }, { value: 30 }, { value: 100 }),
      { min: 0, max: 100 },
    );

    if (result.type !== 'numeric') throw new Error('wrong type');
    expect(result.summary.count).toBe(4);
    expect(result.summary.average).toBe(40);
    expect(result.summary.median).toBe(25);
    expect(result.summary.min).toBe(10);
    expect(result.summary.max).toBe(100);
  });

  it('takes the median of an odd count from the middle', () => {
    const result = aggregate('guess_number', rows({ value: 1 }, { value: 5 }, { value: 100 }), {
      min: 0,
      max: 100,
    });
    if (result.type !== 'numeric') throw new Error('wrong type');
    expect(result.summary.median).toBe(5);
  });

  it('puts the maximum value in the last histogram bucket, not past the end', () => {
    const result = aggregate('guess_number', rows({ value: 100 }), { min: 0, max: 100 });
    if (result.type !== 'numeric') throw new Error('wrong type');
    const total = result.summary.buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
    expect(result.summary.buckets[result.summary.buckets.length - 1]?.count).toBe(1);
  });

  /* ---------------- NPS ---------------- */

  it('computes NPS as promoters minus detractors', () => {
    // 2 promoters, 1 passive, 1 detractor out of 4 => 50 - 25 = 25
    const result = aggregate(
      'nps',
      rows({ score: 10 }, { score: 9 }, { score: 8 }, { score: 3 }),
      {},
    );

    if (result.type !== 'nps') throw new Error('wrong type');
    expect(result.summary.promoters).toBe(2);
    expect(result.summary.passives).toBe(1);
    expect(result.summary.detractors).toBe(1);
    expect(result.summary.score).toBe(25);
  });

  it('rejects out-of-range NPS scores', () => {
    const result = aggregate(
      'nps',
      rows({ score: 11 }, { score: -1 }, { score: 5.5 }, { score: 7 }),
      {},
    );
    if (result.type !== 'nps') throw new Error('wrong type');
    expect(result.summary.count).toBe(1);
  });

  it('reports zero rather than dividing by zero with no answers', () => {
    const result = aggregate('nps', [], {});
    if (result.type !== 'nps') throw new Error('wrong type');
    expect(result.summary.score).toBe(0);
  });

  /* ---------------- scales ---------------- */

  it('averages each statement independently', () => {
    const result = aggregate(
      'scales',
      rows({ values: { s1: 4, s2: 2 } }, { values: { s1: 2, s2: 2 } }),
      {
        statements: [
          { id: 's1', label: 'Clear' },
          { id: 's2', label: 'Useful' },
        ],
      },
    );

    if (result.type !== 'scales') throw new Error('wrong type');
    expect(result.statements[0]?.average).toBe(3);
    expect(result.statements[1]?.average).toBe(2);
  });

  /* ---------------- ranking ---------------- */

  it('ranks by average position, best first', () => {
    const result = aggregate(
      'ranking',
      rows({ order: ['a', 'b', 'c'] }, { order: ['a', 'c', 'b'] }),
      {
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
        ],
      },
    );

    if (result.type !== 'ranking') throw new Error('wrong type');
    expect(result.items[0]?.id).toBe('a');
    expect(result.items[0]?.averageRank).toBe(1);
    expect(result.items[1]?.averageRank).toBe(2.5);
  });

  it('sorts unranked items last instead of first', () => {
    // averageRank is 0 for an item nobody ranked, which would otherwise
    // sort it to the top as though it had won.
    const result = aggregate('ranking', rows({ order: ['a'] }), {
      items: [
        { id: 'a', label: 'Ranked' },
        { id: 'z', label: 'Never ranked' },
      ],
    });
    if (result.type !== 'ranking') throw new Error('wrong type');
    expect(result.items[0]?.id).toBe('a');
    expect(result.items[1]?.id).toBe('z');
  });

  /* ---------------- points ---------------- */

  it('totals allocated points and their share', () => {
    const result = aggregate(
      'points_100',
      rows({ allocation: { a: 60, b: 40 } }, { allocation: { a: 40, b: 60 } }),
      {
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
    );

    if (result.type !== 'points') throw new Error('wrong type');
    expect(result.items[0]?.total).toBe(100);
    expect(result.items[0]?.percent).toBe(50);
  });

  /* ---------------- grid ---------------- */

  it('averages grid positions per item', () => {
    const result = aggregate(
      'grid_2x2',
      rows({ positions: { a: { x: 0, y: 0 } } }, { positions: { a: { x: 1, y: 1 } } }),
      { items: [{ id: 'a', label: 'A' }] },
    );

    if (result.type !== 'scatter') throw new Error('wrong type');
    expect(result.points[0]?.x).toBe(0.5);
    expect(result.points[0]?.y).toBe(0.5);
    expect(result.points[0]?.count).toBe(2);
  });

  it('centres an item nobody placed', () => {
    const result = aggregate('grid_2x2', [], { items: [{ id: 'a', label: 'A' }] });
    if (result.type !== 'scatter') throw new Error('wrong type');
    expect(result.points[0]?.x).toBe(0.5);
    expect(result.points[0]?.count).toBe(0);
  });

  /* ---------------- pins ---------------- */

  it('collects every pin from every answer', () => {
    const result = aggregate(
      'pin_image',
      rows(
        {
          pins: [
            { x: 0.1, y: 0.2 },
            { x: 0.3, y: 0.4 },
          ],
        },
        { pins: [{ x: 0.5, y: 0.6 }] },
      ),
      {},
    );
    if (result.type !== 'pins') throw new Error('wrong type');
    expect(result.pins).toHaveLength(3);
  });

  /* ---------------- content ---------------- */

  it('reports nothing to chart for content slides', () => {
    expect(aggregate('heading', rows({}), {}).type).toBe('none');
    expect(aggregate('image', rows({}), {}).type).toBe('none');
  });
});
