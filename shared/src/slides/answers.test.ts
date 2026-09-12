import { describe, it, expect } from 'vitest';
import { zAnswer } from './answers.js';

/**
 * These guard the contract between the phone and the server.
 *
 * A field that is required here but not sent by the phone rejects every
 * answer from a real device — which is exactly what happened with
 * elapsedMs, and was only visible when someone answered a quiz on a phone.
 */
describe('answer schemas', () => {
  it('accepts a quiz answer without timing, as a phone sends it', () => {
    const result = zAnswer.safeParse({ kind: 'quiz_select', optionIds: ['a'] });
    expect(result.success, 'a quiz answer with no elapsedMs must be accepted').toBe(true);
  });

  it('defaults missing timing to zero rather than undefined', () => {
    const result = zAnswer.parse({ kind: 'quiz_select', optionIds: ['a'] });
    expect((result as { elapsedMs: number }).elapsedMs).toBe(0);
  });

  it('keeps timing when the phone does send it', () => {
    const result = zAnswer.parse({ kind: 'quiz_select', optionIds: ['a'], elapsedMs: 4200 });
    expect((result as { elapsedMs: number }).elapsedMs).toBe(4200);
  });

  it('accepts every quiz kind without timing', () => {
    const answers = [
      { kind: 'quiz_select', optionIds: ['a'] },
      { kind: 'quiz_type', text: 'Paris' },
      { kind: 'quiz_order', order: ['a', 'b'] },
      { kind: 'quiz_match', matches: { p1: 'left' } },
    ];

    for (const answer of answers) {
      expect(zAnswer.safeParse(answer).success, `${answer.kind} rejected`).toBe(true);
    }
  });

  it('still rejects a negative time, which cannot be honest', () => {
    expect(
      zAnswer.safeParse({ kind: 'quiz_select', optionIds: ['a'], elapsedMs: -1 }).success,
    ).toBe(false);
  });

  it('accepts the ordinary non-quiz answers a phone sends', () => {
    const answers = [
      { kind: 'word_cloud', words: ['hello'] },
      { kind: 'open_text', text: 'A sentence' },
      { kind: 'multiple_choice', optionIds: ['a'] },
      { kind: 'true_false', value: true },
      { kind: 'nps', score: 9 },
      { kind: 'star_rating', stars: 4 },
      { kind: 'guess_number', value: 42 },
    ];

    for (const answer of answers) {
      expect(zAnswer.safeParse(answer).success, `${answer.kind} rejected`).toBe(true);
    }
  });

  it('rejects an unknown kind rather than storing it', () => {
    expect(zAnswer.safeParse({ kind: 'not_a_kind', value: 1 }).success).toBe(false);
  });
});
