/**
 * Keeping the projector clean.
 *
 * A word cloud on a wall in front of a room is the one place where a single
 * rude submission does real damage, and the presenter cannot un-see it
 * fast enough. This is the guard that stops it arriving.
 *
 * Deliberately narrow. An aggressive filter that rejects "Scunthorpe" or
 * "assignment" is worse than none: people retype, get rejected again, and
 * conclude the thing is broken. So this matches whole words only, keeps the
 * list to terms nobody submits by accident, and errs towards letting
 * something through — the presenter can still remove any answer by hand.
 */

/**
 * Terms blocked outright.
 *
 * Kept short on purpose: every addition is a chance to reject an innocent
 * word, and the presenter's own delete button is the real backstop.
 */
const BLOCKED = [
  'fuck',
  'fucking',
  'fucker',
  'shit',
  'shitty',
  'bitch',
  'bastard',
  'cunt',
  'dick',
  'cock',
  'pussy',
  'asshole',
  'arsehole',
  'wanker',
  'twat',
  'slut',
  'whore',
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'retarded',
  'spastic',
  'chink',
  'paki',
  'kike',
  'tranny',
  'rape',
  'rapist',
];

/**
 * Characters people substitute to slip past a filter.
 *
 * Normalising them first means the list above does not need an entry for
 * every spelling of every word.
 */
const SUBSTITUTIONS: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  '+': 't',
};

/** Reduces a word to the form the block list is written in. */
function normalise(word: string): string {
  return (
    word
      .toLowerCase()
      .normalize('NFKD')
      // Accents, so "shít" is caught.
      .replace(/[̀-ͯ]/g, '')
      .split('')
      .map((character) => SUBSTITUTIONS[character] ?? character)
      .join('')
      // Repeated letters, so "shiiiit" reduces to "shit".
      .replace(/(.)\1{2,}/g, '$1')
      .replace(/[^a-z]/g, '')
  );
}

const BLOCKED_SET = new Set(BLOCKED.map(normalise));

/**
 * Whether text contains something that should not reach a projector.
 *
 * Whole words only. A substring match would reject "class" for containing
 * "ass", which is exactly the failure that makes people distrust a filter.
 */
export function isProfane(text: string): boolean {
  const words = text.split(/[\s\-_/.,;:!?()"']+/).filter((word) => word !== '');

  return words.some((word) => BLOCKED_SET.has(normalise(word)));
}

/**
 * Replaces blocked words rather than rejecting the whole answer.
 *
 * Used where the rest of a sentence is still worth showing. A word cloud
 * rejects outright instead, because a single starred-out entry on a wall
 * draws more attention than the word would have.
 */
export function mask(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      const clean = normalise(part);
      if (clean === '' || !BLOCKED_SET.has(clean)) return part;
      return '*'.repeat(Math.max(part.trim().length, 3));
    })
    .join('');
}
