import { describe, expect, it } from 'vitest';
import type { InputEntry } from '../schema/index.js';
import type { LoadedSong } from './project.js';
import { applySolo, soloView } from './solo.js';

// The walk, on the shape creek actually has: main places bed and a
// vocal; bed places drums and keys; drums sends to a shared room. Solo
// drums and the audible world is drums, its room, and the path up —
// with keys and the vocal filtered where they sit.

const entry = (fields: Partial<InputEntry>): InputEntry => ({
  anchor: 'musical',
  at: 0,
  source_offset: 0,
  slip: 0,
  gain_db: 0,
  pan: 0,
  mute: false,
  fade_in: 0,
  fade_out: 0,
  ...fields,
});

const track = (name: string, inputs: InputEntry[]) =>
  ({ data: { name, inserts: [], sends: {}, inputs } }) as unknown as LoadedSong['tracks'][number];

const song = (): LoadedSong =>
  ({
    name: 'creek',
    dir: 'songs/creek',
    tracks: [
      track('main', [entry({ track: 'bed' }), entry({ audio: 'vox' })]),
      track('bed', [entry({ track: 'drums' }), entry({ track: 'keys' })]),
      track('drums', [entry({ audio: 'kit' })]),
      track('keys', [entry({ audio: 'piano' })]),
      track('space', [entry({ receive: 'room' })]),
    ],
    cables: [
      { label: 'room', sender: 'drums', receiver: 'space', gainDb: 0, tap: 'post', arrivals: [] },
    ],
    genTakes: new Map(),
  }) as unknown as LoadedSong;

describe('solo', () => {
  it('keeps the soloed subtree, its carriers, and its send receivers', () => {
    const s = song();
    applySolo(s, 'drums');
    const by = new Map(s.tracks.map((t) => [t.data.name, t.data.inputs]));
    // main carries only the path to the solo: the vocal drops.
    expect(by.get('main')!.map((e) => e.track)).toEqual(['bed']);
    // bed keeps drums, drops keys.
    expect(by.get('bed')!.map((e) => e.track)).toEqual(['drums']);
    // the soloed subtree is untouched.
    expect(by.get('drums')!).toHaveLength(1);
    // the send stays audible: the cable and its receive both survive.
    expect(s.cables).toHaveLength(1);
    expect(by.get('space')!.map((e) => e.receive)).toEqual(['room']);
    // keys still renders if asked directly, but nothing consumes it.
    expect(by.get('keys')!).toHaveLength(0);
  });

  it('soloing a carrier keeps its whole subtree', () => {
    const s = song();
    applySolo(s, 'bed');
    const by = new Map(s.tracks.map((t) => [t.data.name, t.data.inputs]));
    expect(by.get('main')!.map((e) => e.track)).toEqual(['bed']);
    expect(by.get('bed')!).toHaveLength(2); // drums AND keys: both are the solo
  });

  it('a muted placement cannot carry the solo', () => {
    const s = song();
    // bed's drums placement is muted: the solo has no path through bed.
    s.tracks[1]!.data.inputs[0]!.mute = true;
    const view = soloView(s, 'drums');
    // bed keeps nothing (its one route to the solo is muted), and main
    // therefore keeps nothing either — the solo is inaudible, which is
    // the honest rendering of soloing a muted placement.
    expect(view.keptInputs.get('bed') ?? new Set()).toEqual(new Set());
    expect(view.keptInputs.get('main') ?? new Set()).toEqual(new Set());
  });

  it('refuses a track that does not exist', () => {
    expect(() => soloView(song(), 'nope')).toThrow('no such track');
  });
});
