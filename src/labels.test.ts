import { describe, expect, it } from 'vitest';
import { formatLabel, matchesPattern, parseLabel, parsePattern } from './labels.js';

describe('labels', () => {
  it('parses and formats //pkg:name', () => {
    const label = parseLabel('//songs/creek/targets:pad-96k');
    expect(label).toEqual({ pkg: 'songs/creek/targets', name: 'pad-96k' });
    expect(formatLabel(label)).toBe('//songs/creek/targets:pad-96k');
  });

  it('rejects relative labels and bad names', () => {
    expect(() => parseLabel('songs/creek:x')).toThrow('absolute');
    expect(() => parseLabel('//songs/creek')).toThrow('missing target name');
    expect(() => parseLabel('//songs/creek:Bad_Name')).toThrow('invalid target name');
    expect(() => parseLabel('//songs//creek:x')).toThrow('invalid package');
  });

  it('parses wildcards', () => {
    expect(parsePattern('//songs/creek:all')).toEqual({ kind: 'package-all', pkg: 'songs/creek' });
    expect(parsePattern('//songs/...')).toEqual({ kind: 'tree', pkg: 'songs' });
    expect(parsePattern('//...')).toEqual({ kind: 'tree', pkg: '' });
    expect(() => parsePattern('///...')).toThrow('invalid package');
  });

  it('matches patterns', () => {
    const label = { pkg: 'songs/creek/targets', name: 'pad-96k' };
    expect(matchesPattern(label, parsePattern('//songs/creek/targets:pad-96k'))).toBe(true);
    expect(matchesPattern(label, parsePattern('//songs/creek/targets:all'))).toBe(true);
    expect(matchesPattern(label, parsePattern('//songs/...'))).toBe(true);
    expect(matchesPattern(label, parsePattern('//songs/creek/...'))).toBe(true);
    expect(matchesPattern(label, parsePattern('//songs/tall-grass/...'))).toBe(false);
    expect(matchesPattern(label, parsePattern('//songs/creek:all'))).toBe(false);
  });
});
