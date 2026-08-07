import { describe, expect, it } from 'vitest';
import { MeterMap, TempoMap } from '../time/tempo.js';
import {
  formatPosition,
  parseMusicalPosition,
  songDirOfPath,
  songDirOfPkg,
} from './transport.js';

const ctx = {
  tempo: new TempoMap([{ at: 0, bpm: 120 }], 48000),
  meter: new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]),
};

describe('song derivation', () => {
  it('finds the song in a label package', () => {
    expect(songDirOfPkg('songs/creek/mix')).toBe('songs/creek');
    expect(songDirOfPkg('songs/creek')).toBe('songs/creek');
    expect(songDirOfPkg('shared/loops')).toBeUndefined();
  });

  it('finds the song in asset and artifact paths', () => {
    expect(songDirOfPath('/p', '/p/songs/creek/audio/kick.wav')).toBe('songs/creek');
    expect(songDirOfPath('/p', '/p/.field/out/songs/creek/mix/main.wav')).toBe('songs/creek');
    expect(songDirOfPath('/p', '/p/shared/thing.wav')).toBeUndefined();
  });
});

describe('musical positions', () => {
  it('projects bar.beat.tick to samples through the tempo map', () => {
    // 120 bpm at 48 kHz: one beat = 24000 samples, one 4/4 bar = 96000.
    expect(parseMusicalPosition('1.1.1', ctx)).toBe(0);
    expect(parseMusicalPosition('1.2.1', ctx)).toBe(24000);
    expect(parseMusicalPosition('2', ctx)).toBe(96000);
  });

  it('formats samples as bar.beat.tick with a clock, or plainly without a map', () => {
    expect(formatPosition(24000, 48000, ctx)).toBe('1.2.1 (0:00.5)');
    expect(formatPosition(96000, 48000, ctx)).toBe('2.1.1 (0:02.0)');
    expect(formatPosition(96000, 48000, undefined)).toBe('sample 96000 (0:02.0)');
  });
});
