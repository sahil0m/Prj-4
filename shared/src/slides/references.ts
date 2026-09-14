import type { Answer } from './answers.js';

/**
 * Checking that an answer points at something that exists.
 *
 * The answer schemas check shape: that `optionIds` is a list of plausible
 * ids. They cannot check meaning, because they do not know which slide the
 * answer belongs to. So an answer naming an option that was renamed, or
 * deleted, or never existed, used to be stored and counted -- adding one to
 * the total while matching no bar, which reads on the projector as answers
 * arriving and every option stuck at zero.
 *
 * A phone holding a slide the author has since edited is the ordinary way
 * this happens; a crafted payload is the other.
 */

/** The ids a slide's own config defines, wherever they live in it. */
export function knownIds(config: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();

  // Every list of things an answer can refer to, under the names the
  // configs actually use.
  for (const key of ['options', 'items', 'statements', 'fields', 'pairs']) {
    const list = config[key];
    if (!Array.isArray(list)) continue;

    for (const entry of list) {
      // A malformed entry is skipped rather than allowed to throw: this
      // decides whether an answer is stored.
      if (!entry || typeof entry !== 'object') continue;

      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    }
  }

  return ids;
}

/** Ids from a list, tolerating a field that is absent or the wrong shape. */
function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Ids used as the keys of a map, tolerating the same. */
function keys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

/**
 * The ids an answer refers to. Empty for kinds that refer to nothing.
 *
 * Reads defensively rather than trusting the type. Callers pass a parsed
 * answer, so the fields are there -- but this decides whether an answer is
 * stored, and it should not be the thing that throws if one day they are
 * not.
 */
export function referencedIds(answer: Answer): string[] {
  const data = answer as unknown as Record<string, unknown>;

  switch (answer.kind) {
    case 'multiple_choice':
    case 'image_choice':
    case 'quiz_select':
      return list(data.optionIds);

    case 'who_will_win':
      return list([data.optionId]);

    case 'ranking':
    case 'quiz_order':
      return list(data.order);

    case 'scales':
      return keys(data.values);

    case 'points_100':
      return keys(data.allocation);

    case 'grid_2x2':
      return keys(data.positions);

    case 'quiz_match':
      return keys(data.matches);

    case 'quick_form':
      return keys(data.fields);

    default:
      // Free text, numbers, pins and drawings name nothing.
      return [];
  }
}

/**
 * The ids in an answer that the slide does not define.
 *
 * Empty when the answer is consistent with the slide, which includes every
 * kind that refers to nothing at all.
 */
export function unknownIds(answer: Answer, config: Record<string, unknown>): string[] {
  const referenced = referencedIds(answer);
  if (referenced.length === 0) return [];

  const known = knownIds(config);

  // A slide that defines no ids cannot be checked -- an older config, or a
  // kind that keeps its choices somewhere this does not know about. Better
  // to accept the answer than to reject every answer to that slide.
  if (known.size === 0) return [];

  return [...new Set(referenced.filter((id) => !known.has(id)))];
}
