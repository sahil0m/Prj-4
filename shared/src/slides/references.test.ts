import { describe, it, expect } from 'vitest';
import { knownIds, referencedIds, unknownIds } from './references.js';
import { SLIDE_REGISTRY, ANSWERABLE_KINDS } from './registry.js';
import type { Answer } from './answers.js';

/*
 * The rule these protect: an answer may only name ids the slide defines.
 *
 * Without it, a phone still holding a slide whose options were edited adds
 * to the answer count while matching no option -- the projector shows
 * answers arriving with every bar at zero, and the exported statistics say
 * the same.
 */

const choice = {
  options: [
    { id: 'o1', label: 'INNER JOIN' },
    { id: 'o2', label: 'FULL OUTER JOIN' },
  ],
};

describe('knownIds', () => {
  it('collects ids from every list a config keeps them in', () => {
    const ids = knownIds({
      options: [{ id: 'o1' }],
      items: [{ id: 'i1' }],
      statements: [{ id: 's1' }],
      fields: [{ id: 'f1' }],
      pairs: [{ id: 'p1' }],
    });

    expect([...ids].sort()).toEqual(['f1', 'i1', 'o1', 'p1', 's1']);
  });

  it('ignores entries with no id rather than throwing', () => {
    expect([...knownIds({ options: [{ label: 'no id' }, 'nonsense', null] })]).toEqual([]);
  });
});

describe('unknownIds', () => {
  it('accepts an answer that names an existing option', () => {
    const answer = { kind: 'multiple_choice', optionIds: ['o1'] } as Answer;
    expect(unknownIds(answer, choice)).toEqual([]);
  });

  it('reports an option the slide does not have', () => {
    const answer = { kind: 'multiple_choice', optionIds: ['o1', 'gone'] } as Answer;
    expect(unknownIds(answer, choice)).toEqual(['gone']);
  });

  it('reports each missing id once', () => {
    const answer = { kind: 'multiple_choice', optionIds: ['gone', 'gone'] } as Answer;
    expect(unknownIds(answer, choice)).toEqual(['gone']);
  });

  it('checks the keys of an allocation, not just lists', () => {
    const answer = { kind: 'points_100', allocation: { i1: 50, ghost: 50 } } as Answer;
    expect(unknownIds(answer, { items: [{ id: 'i1', label: 'One' }] })).toEqual(['ghost']);
  });

  it('accepts kinds that name nothing at all', () => {
    const answer = { kind: 'word_cloud', words: ['hello'] } as Answer;
    expect(unknownIds(answer, choice)).toEqual([]);
  });

  /*
   * A slide whose config keeps no ids cannot be checked. Rejecting those
   * would refuse every answer to them, which is far worse than accepting
   * one that cannot be verified.
   */
  it('accepts anything when the slide defines no ids', () => {
    const answer = { kind: 'multiple_choice', optionIds: ['o1'] } as Answer;
    expect(unknownIds(answer, {})).toEqual([]);
  });
});

describe('referencedIds', () => {
  it('handles every answerable kind without throwing', () => {
    // A new kind that refers to ids must be added to referencedIds, or its
    // answers go unchecked. This walks all of them with their own defaults.
    for (const kind of ANSWERABLE_KINDS) {
      const config = SLIDE_REGISTRY[kind].defaults() as Record<string, unknown>;
      const answer = { kind } as Answer;

      expect(() => referencedIds(answer), kind).not.toThrow();
      expect(() => unknownIds(answer, config), kind).not.toThrow();
    }
  });
});
