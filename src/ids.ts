import { randomInt } from 'node:crypto';

// Names are identity (project-core.md §6): human-named things use slugs,
// machine-minted things get a slug plus a short random suffix.
export const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

// Lowercase letters and digits minus lookalikes (i, l, o, 0, 1).
const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomSuffix(length = 5): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return out;
}

export function mintId(slug: string): string {
  return `${slug}-${randomSuffix()}`;
}
