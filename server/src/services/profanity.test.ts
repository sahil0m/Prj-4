import { describe, it, expect } from 'vitest';
import { isProfane, mask } from './profanity.js';

/**
 * The false positives matter more than the false negatives here.
 *
 * A rude word slipping through is embarrassing for a moment and the
 * presenter can delete it. A filter that rejects "class" or "Scunthorpe"
 * makes people retype, fail again, and conclude the product is broken —
 * and there is no way for them to find out why.
 */
describe('isProfane', () => {
  it('catches the obvious', () => {
    expect(isProfane('fuck')).toBe(true);
    expect(isProfane('this is shit')).toBe(true);
  });

  it('catches character substitutions', () => {
    expect(isProfane('sh1t')).toBe(true);
    expect(isProfane('f*ck'.replace('*', 'u'))).toBe(true);
    expect(isProfane('@sshole')).toBe(true);
  });

  it('catches padded repeats', () => {
    expect(isProfane('shiiiiit')).toBe(true);
  });

  it('catches accented spellings', () => {
    expect(isProfane('shít')).toBe(true);
  });

  /* ---------------- the important half ---------------- */

  it('does not reject words that merely contain one', () => {
    // The classic failure: a substring match rejects all of these.
    const innocent = [
      'class',
      'classic',
      'assignment',
      'assess',
      'assumption',
      'pass',
      'grass',
      'bass',
      'compass',
      'Scunthorpe',
      'Penistone',
      'analysis',
      'cockpit',
      'cocktail',
      'shiitake',
      'dickens',
      'therapist',
      'titles',
      'bitchen',
    ];

    for (const word of innocent) {
      expect(isProfane(word), `"${word}" was wrongly blocked`).toBe(false);
    }
  });

  it('leaves ordinary sentences alone', () => {
    const sentences = [
      'The standups are too long',
      'I love the new CI pipeline',
      'Requirements keep changing mid-sprint',
      'Our class analysis was a pass',
      'We should assess the assignment',
    ];

    for (const sentence of sentences) {
      expect(isProfane(sentence), `"${sentence}" was wrongly blocked`).toBe(false);
    }
  });

  it('handles empty and odd input without throwing', () => {
    expect(isProfane('')).toBe(false);
    expect(isProfane('   ')).toBe(false);
    expect(isProfane('!!!')).toBe(false);
    expect(isProfane('123')).toBe(false);
  });

  it('catches a word inside a sentence', () => {
    expect(isProfane('this sprint was shit honestly')).toBe(true);
  });

  it('catches one separated by punctuation', () => {
    expect(isProfane('well, shit.')).toBe(true);
    expect(isProfane('what-the-fuck')).toBe(true);
  });
});

describe('mask', () => {
  it('replaces only the offending word', () => {
    expect(mask('this is shit honestly')).toBe('this is **** honestly');
  });

  it('leaves clean text untouched', () => {
    expect(mask('a perfectly ordinary sentence')).toBe('a perfectly ordinary sentence');
  });

  it('keeps the spacing so the sentence still reads', () => {
    const result = mask('well shit that is bad');
    expect(result.split(' ')).toHaveLength(5);
  });
});
