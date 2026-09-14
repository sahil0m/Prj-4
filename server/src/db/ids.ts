import { randomBytes } from 'node:crypto';

/**
 * Row ids.
 *
 * The same shape MongoDB used -- 24 hex characters, the first eight being
 * seconds since the epoch -- for two reasons. Every migrated row keeps its
 * original id, so links, tokens and cookies issued before the move still
 * resolve; and ids sort by creation time, which the admin list's keyset
 * pagination relies on. Mixing formats would break both quietly.
 *
 * The remaining twelve bytes' worth of hex is random rather than a machine
 * id and counter. Nothing here needs to decode an id, and randomness needs
 * no coordination between server instances.
 */
export function newId(): string {
  const seconds = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0');

  return seconds + randomBytes(8).toString('hex');
}

const ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Whether a string could be an id.
 *
 * Checked before a query so a malformed id from a URL becomes a clean 404
 * rather than a round trip that can only ever find nothing.
 */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
