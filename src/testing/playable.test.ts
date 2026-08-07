import { describe, expect, it } from 'vitest';
import { playable } from './playable.js';

// The factory exists so a new required field costs one edit, and that
// part is enforced by the compiler. What the compiler cannot check is
// the one line here that computes rather than defaults: `pkg` is derived
// from the label, and a wrong derivation is silent — `withClick` only
// uses it to pick a directory, so nothing fails until something asks the
// project for that package's tempo map, far away (#40 review).

describe('playable', () => {
  it('derives pkg from the label', () => {
    expect(playable({ path: '/tmp/x.wav' })).toMatchObject({
      label: '//songs/x/mix:main',
      pkg: 'songs/x/mix',
    });
    expect(playable({ path: '/tmp/x.wav', label: '//songs/creek/track:keys' }).pkg).toBe(
      'songs/creek/track',
    );
    expect(playable({ path: '/tmp/x.wav', label: '//shared/asset:water' }).pkg).toBe(
      'shared/asset',
    );
  });

  it('lets a caller override the derivation', () => {
    // Deriving is the convenience, not the contract: a test that wants a
    // pkg its label does not imply — a playable outside any song, say —
    // must still be able to say so.
    const item = playable({ path: '/tmp/x.wav', label: '//songs/x/mix:main', pkg: 'elsewhere' });
    expect(item.pkg).toBe('elsewhere');
  });

  it('keeps the path it was given, since that is the one thing it will not invent', () => {
    expect(playable({ path: '/tmp/specific.wav' }).path).toBe('/tmp/specific.wav');
  });
});
