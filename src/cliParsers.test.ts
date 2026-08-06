import { describe, expect, it } from 'vitest';
import {
  parseBars,
  parseBpm,
  parseChannels,
  parseDurationSeconds,
  parseSeed,
  parseVariantNumber,
  parseVariants,
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
