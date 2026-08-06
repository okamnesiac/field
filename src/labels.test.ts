import { describe, expect, it } from 'vitest';
import { formatLabel, matchesPattern, parseLabel, parsePattern } from './labels.js';

describe('labels', () => {
  it('parses and formats //pkg:name', () => {
    const label = parseLabel('//songs/creek/targets:pad-96k');
    expect(label).toEqual({ pkg: 'songs/creek/targets', name: 'pad-96k' });
    expect(formatLabel(label)).toBe('//songs/creek/targets:pad-96k');
  });

  it('rejects bad names and malformed labels', () => {
    expect(() => parseLabel('//songs/creek')).toThrow('missing target name');
    expect(() => parseLabel('//songs/creek:Bad_Name')).toThrow('invalid target name');
    expect(() => parseLabel('//songs//creek:x')).toThrow('invalid package');
    expect(() => parseLabel('/creek:x')).toThrow('songs-relative');
  });

  // Songs-relative shorthand (project-core.md §3.4, amended): the CLI
  // accepts what people actually type; canonical output stays absolute.
  it('expands songs-relative shorthand uniformly — no special cases', () => {
    expect(parseLabel('creek/mix:main')).toEqual({ pkg: 'songs/creek/mix', name: 'main' });
    // Even a song literally named "songs": shorthand always prefixes.
    expect(parseLabel('songs/mix:main')).toEqual({ pkg: 'songs/songs/mix', name: 'main' });
    expect(parseLabel('songs')).toEqual({ pkg: 'songs/songs/mix', name: 'main' });
    expect(parsePattern('creek/...')).toEqual({ kind: 'tree', pkg: 'songs/creek' });
    expect(parsePattern('creek/tracks:all')).toEqual({
      kind: 'package-all',
      pkg: 'songs/creek/tracks',
    });
    expect(parsePattern('...')).toEqual({ kind: 'tree', pkg: 'songs' });
  });

  it('a bare song name means its main mix', () => {
    expect(parseLabel('creek')).toEqual({ pkg: 'songs/creek/mix', name: 'main' });
    expect(() => parseLabel('Creek')).toThrow('invalid package');
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
