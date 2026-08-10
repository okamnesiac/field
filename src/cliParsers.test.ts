import { describe, expect, it } from 'vitest';
import {
  parseBars,
  parseGenTarget,
  parseBpm,
  parseChannels,
  parseDurationSeconds,
  parseSeed,
  parseVariantNumber,
  parseVariants,
  wantsVersion,
} from './cliParsers.js';

describe('cli parsers', () => {
  it('accepts valid values', () => {
    expect(parseSeed('90210')).toBe(90210);
    expect(parseSeed('0')).toBe(0);
    expect(parseDurationSeconds('10')).toBe(10);
    expect(parseDurationSeconds('0.25')).toBe(0.25);
    expect(parseChannels('1')).toBe(1);
    expect(parseChannels('2')).toBe(2);
  });

  it('rejects what the schema rejects, instead of silently coercing', () => {
    expect(() => parseSeed('abc')).toThrow('non-negative integer'); // was NaN → sclang seed 0
    expect(() => parseSeed('-1')).toThrow('non-negative integer');
    expect(() => parseSeed('1.5')).toThrow('non-negative integer');
    expect(() => parseDurationSeconds('abc')).toThrow('(0, 3600]');
    expect(() => parseDurationSeconds('0')).toThrow('(0, 3600]');
    expect(() => parseDurationSeconds('3601')).toThrow('(0, 3600]');
    expect(() => parseChannels('5')).toThrow('1 or 2');
  });

  // The ace flags fail at the flag, in the flag's own vocabulary — never
  // downstream as a daemon range error, and never (the #18 finding) as a
  // recipe-schema throw after the WAVs already landed.
  it('ace generate/choose flags reject what their schemas reject', () => {
    expect(parseBars('4')).toBe(4);
    expect(() => parseBars('abc')).toThrow('positive integer');
    expect(() => parseBars('2.5')).toThrow('positive integer');
    expect(parseVariants('2')).toBe(2);
    expect(() => parseVariants('3.7')).toThrow('[1, 8]');
    expect(() => parseVariants('9')).toThrow('[1, 8]');
    expect(parseBpm('96')).toBe(96);
    expect(() => parseBpm('30.5')).toThrow('integer'); // was: WAVs on disk, no recipe
    expect(() => parseBpm('500')).toThrow('[30, 300]');
    expect(parseVariantNumber('1')).toBe(1);
    expect(() => parseVariantNumber('0')).toThrow('positive integer');
  });
});

describe('wantsVersion', () => {
  // `field --version` is the one way to ask, so the check has to be exact
  // about which invocations mean it.
  it('recognises both spellings in the only position that means the program', () => {
    expect(wantsVersion(['node', 'field', '--version'])).toBe(true);
    expect(wantsVersion(['node', 'field', '-V'])).toBe(true);
  });

  it('leaves the flag to commander anywhere else', () => {
    // `argv.includes('--version')` matched anywhere, so `field build
    // --version` printed a version report and never built — a different
    // command substituted silently, where a parser would have complained
    // (#70 review).
    expect(wantsVersion(['node', 'field', 'build', '--version'])).toBe(false);
    expect(wantsVersion(['node', 'field', 'build', '//songs/...', '--version'])).toBe(false);
    // And a value that happens to equal the flag is a value, not a request.
    expect(
      wantsVersion(['node', 'field', 'generate', 'line', '--text', '--version']),
    ).toBe(false);
  });

  it('is false for no arguments at all', () => {
    expect(wantsVersion(['node', 'field'])).toBe(false);
  });
});

describe('parseGenTarget', () => {
  // The song rides in the argument, in every spelling the CLI itself
  // prints — there is no --song, because two ways to say one thing is a
  // search path over flags (project-core.md §3.4's rule).
  it('accepts song/name, song/gen:name, and the full label', () => {
    expect(parseGenTarget('creek/still-water-keys', 'choose')).toEqual({
      song: 'creek',
      name: 'still-water-keys',
    });
    expect(parseGenTarget('creek/gen:still-water-keys', 'choose')).toEqual({
      song: 'creek',
      name: 'still-water-keys',
    });
    expect(parseGenTarget('//songs/creek/gen:lead-take', 'generate')).toEqual({
      song: 'creek',
      name: 'lead-take',
    });
  });

  it('a bare name is told the spelling that carries the song', () => {
    expect(() => parseGenTarget('still-water-keys', 'choose')).toThrow(
      'field choose <song>/still-water-keys',
    );
    // Stripping a gen: prefix first, so the advice is pasteable.
    expect(() => parseGenTarget('gen:lead-take', 'generate')).toThrow(
      'field generate <song>/lead-take',
    );
  });

  it('refuses other packages and non-songs labels by name', () => {
    expect(() => parseGenTarget('creek/track:keys', 'choose')).toThrow(
      'choose addresses a gen node',
    );
    expect(() => parseGenTarget('//shared/asset:pad', 'choose')).toThrow(
      'only //songs/ labels',
    );
  });
});
