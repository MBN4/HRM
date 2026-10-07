import { randomInt } from 'node:crypto';

// Visually ambiguous characters (0/O, 1/l/I) are left out: HR reads or
// copies this to another person, often over chat or a call.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*-_=+?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

const pick = (chars: string): string => chars[randomInt(chars.length)];

/**
 * A CSPRNG-backed (`crypto.randomInt`, never `Math.random`) temporary
 * password: guaranteed to contain one character of each class, then
 * Fisher-Yates shuffled so the guaranteed characters aren't in fixed
 * positions. ~16 chars from a 70-symbol alphabet is ≈ 98 bits — far beyond
 * guessable, and it only lives until the member's forced first-login change.
 */
export function generateTemporaryPassword(length = 16): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) {
    chars.push(pick(ALL));
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
