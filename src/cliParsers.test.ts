import { describe, expect, it } from 'vitest';
import { parseChannels, parseDurationSeconds, parseSeed } from './cliParsers.js';

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
});
