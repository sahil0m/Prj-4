import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { SLIDE_KINDS, SLIDE_REGISTRY } from '@pulse/shared';

/**
 * Every slide kind must draw something on the projector.
 *
 * Three of them did not. Q&A, Compare and the leaderboard could each be
 * added to a deck, filled in and presented, and the room saw an empty
 * wall -- because the content renderer ends in `default: return null`, so
 * a kind nobody wired up fails silently and looks like a slow network.
 *
 * The registry is the spine of the codebase and the compiler catches most
 * of what a new kind needs, but it cannot catch a missing branch of a
 * switch that has a default. This is that check.
 */

const source = readFileSync(fileURLToPath(new URL('./Presenter.tsx', import.meta.url)), 'utf8');

/**
 * Kinds the stage draws before it ever reaches the content renderer.
 *
 * Each is checked against the file rather than listed from memory, so
 * deleting one of those branches fails here rather than in a room.
 */
const SPECIAL_CASED = ['leaderboard', 'qa', 'compare'] as const;

/** Case labels inside the ContentSlide switch. */
function contentSlideCases(): Set<string> {
  const body = source.slice(source.indexOf('function ContentSlide'));
  return new Set([...body.matchAll(/case '([a-z0-9_]+)'/g)].map((match) => match[1] ?? ''));
}

describe('presenter slide coverage', () => {
  it('draws something for every kind the audience does not answer', () => {
    const handled = contentSlideCases();

    const blank = SLIDE_KINDS.filter((kind) => {
      if (SLIDE_REGISTRY[kind].answerable) return false;
      if (SPECIAL_CASED.includes(kind as (typeof SPECIAL_CASED)[number])) return false;
      return !handled.has(kind);
    });

    expect(
      blank,
      `these render a blank screen; add a case to ContentSlide in Presenter.tsx: ${blank.join(', ')}`,
    ).toEqual([]);
  });

  it('still special-cases the kinds that need their own component', () => {
    // These three are not in ContentSlide: they need live data rather than
    // config, so the stage picks them before it gets there. If a branch is
    // removed the kind falls through to `default: return null`, which is
    // silent -- exactly the failure this file exists to prevent.
    for (const kind of SPECIAL_CASED) {
      expect(
        source.includes(`slide?.kind === '${kind}'`),
        `the stage no longer handles '${kind}', so it will render nothing`,
      ).toBe(true);
    }
  });

  it('every answerable kind is answerable on a phone', () => {
    const input = readFileSync(
      fileURLToPath(new URL('../../../join/src/components/AnswerInput.tsx', import.meta.url)),
      'utf8',
    );

    const handled = new Set([...input.matchAll(/case '([a-z0-9_]+)'/g)].map((m) => m[1] ?? ''));

    const missing = SLIDE_KINDS.filter(
      (kind) => SLIDE_REGISTRY[kind].answerable && !handled.has(kind),
    );

    expect(
      missing,
      `these have no input on the phone, so the audience cannot answer them: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
