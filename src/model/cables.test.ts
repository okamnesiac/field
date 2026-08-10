import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../commands/init.js';
import { createSong } from '../commands/create.js';
import { check } from '../commands/check.js';
import { fmt } from '../commands/fmt.js';
import { buildLabels } from '../commands/build.js';
import { TempoMap } from '../time/tempo.js';
import { trackOrder, type InputEntry, type Track } from '../schema/index.js';
import type { LoadedFile } from './project.js';
import { checkCables, type TrackClock } from './cables.js';

// The cable model (nested-tracks.md §19): resolution and 1:1 checks,
// dangling-end warnings, the zero-displacement rule, arrival derivation
// and agreement, and cycles on the combined graph. Unit tests drive
// checkCables directly where the arrival numbers are the point; the
// check() tests cover the same rules end to end, message spellings
// included. At 120 bpm, 4/4, 48 kHz: a bar is 3840 ticks = 96000
// samples.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-test-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const track = (name: string, lines: string[]) => {
  writeFileSync(join(root, `songs/opener/tracks/${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
};
const messages = async () => {
  const result = await check(root);
  return {
    result,
    errors: result.diagnostics.filter((d) => d.severity === undefined).map((d) => d.message),
    warnings: result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message),
  };
};

// --- unit fixtures -------------------------------------------------------

const entry = (fields: Partial<InputEntry>): InputEntry => ({
  anchor: 'musical',
  at: 0,
  source_offset: 0,
  slip: 0,
  gain_db: 0,
  pan: 0,
  fade_in: 0,
  fade_out: 0,
  ...fields,
});

const trackData = (name: string, fields: Partial<Track>): Track => ({
  name,
  inserts: [],
  sends: {},
  inputs: [],
  ...fields,
});

const loaded = (data: Track): LoadedFile<Track> => ({
  path: `songs/opener/tracks/${data.name}.yaml`,
  data,
  raw: '',
  order: trackOrder,
});

const clocksAt = (tracks: Track[], rates: Record<string, number> = {}): Map<string, TrackClock> =>
  new Map(
    tracks.map((t) => {
      const rate = rates[t.name] ?? 48000;
      return [t.name, { rate, tempo: new TempoMap([{ at: 0, bpm: 120 }], rate) }];
    }),
  );

function run(tracks: Track[], rates: Record<string, number> = {}) {
  const pushed: { file: string; message: string; severity?: 'warning' }[] = [];
  const cables = checkCables(tracks.map(loaded), clocksAt(tracks, rates), (file, message, severity) =>
    pushed.push({ file, message, ...(severity ? { severity } : {}) }),
  );
  return { cables, pushed };
}

describe('checkCables: arrival derivation', () => {
  it('derives one arrival per sender placement, through nesting (§19 decision 5)', () => {
    // main → verse@bar1,bar3 → keys@bar2: keys' zero lands at
    // verse+bar → arrivals at bars 2 and 4.
    const keys = trackData('keys', { sends: { verb: { gain_db: -6, tap: 'post' } } });
    const verse = trackData('verse', { inputs: [entry({ track: 'keys', at: 3840 })] });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const main = trackData('main', {
      inputs: [
        entry({ track: 'verse' }),
        entry({ track: 'verse', at: 7680 }),
        entry({ track: 'space' }),
      ],
    });
    const { cables, pushed } = run([keys, verse, space, main]);
    expect(pushed).toEqual([]);
    expect(cables).toHaveLength(1);
    expect(cables[0]).toMatchObject({
      label: 'verb',
      sender: 'keys',
      receiver: 'space',
      gainDb: -6,
      tap: 'post',
    });
    // verse at 0 + keys at bar 1 → 96000; verse at bar 2 + keys → 288000.
    expect(cables[0]!.arrivals).toEqual([96000, 288000]);
  });

  it('a looped sender placement arrives once per repetition', () => {
    const kick = trackData('kick', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const main = trackData('main', {
      inputs: [
        entry({
          track: 'kick',
          at: 0,
          duration: 7680, // two bars
          loop: { enabled: true, every: 3840, mode: 'truncate', fade: 480 },
        }),
        entry({ track: 'space' }),
      ],
    });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const { cables, pushed } = run([kick, main, space]);
    expect(pushed).toEqual([]);
    expect(cables[0]!.arrivals).toEqual([0, 96000]);
  });

  it('slip and source_offset displace the sender arrival on their own axis', () => {
    // read_offset = source_offset − slip = −4800: the content plays
    // 4800 samples later than its window, so its zero arrives at +4800.
    const keys = trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const main = trackData('main', {
      inputs: [entry({ track: 'keys', slip: 4800 }), entry({ track: 'space' })],
    });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const { cables } = run([keys, main, space]);
    expect(cables[0]!.arrivals).toEqual([4800]);
  });

  it('converts arrivals across a track-rate boundary (multi-rate.md)', () => {
    // The sender renders at 96 kHz inside a 48 kHz mix: its placement is
    // planned in the parent's clock, so the arrival is bar 1 in the
    // receiver's 48 kHz samples regardless of the sender's rate.
    const keys = trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const main = trackData('main', {
      inputs: [entry({ track: 'keys', at: 3840 }), entry({ track: 'space' })],
    });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const { cables, pushed } = run([keys, main, space], { keys: 96000 });
    expect(pushed).toEqual([]);
    expect(cables[0]!.arrivals).toEqual([96000]);
  });

  it('a receiver at its own rate hears arrivals in its own samples', () => {
    const keys = trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const main = trackData('main', {
      inputs: [entry({ track: 'keys', at: 3840 }), entry({ track: 'space' })],
    });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    // Bar 1 is 96000 samples of the 48 kHz mix = 192000 of the 96 kHz
    // receiver's clock.
    const { cables } = run([keys, main, space], { space: 96000 });
    expect(cables[0]!.arrivals).toEqual([192000]);
  });

  it('a circuit inside a placed subtree derives relative to the subtree, not the root', () => {
    // Both ends inside verse, verse placed twice: the circuit repeats
    // with its section (§19 decision 5), so the arrivals are verse-local
    // and the placements do not multiply them.
    const kick = trackData('kick', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const verse = trackData('verse', {
      inputs: [entry({ track: 'kick', at: 960 }), entry({ track: 'space' })],
    });
    const main = trackData('main', {
      inputs: [entry({ track: 'verse' }), entry({ track: 'verse', at: 7680 })],
    });
    const { cables, pushed } = run([kick, space, verse, main]);
    expect(pushed).toEqual([]);
    expect(cables[0]!.arrivals).toEqual([24000]);
  });

  it('a receiver inside a containment cycle is the cycle diagnostic to report, not a cable error', () => {
    // a ⇄ b is a containment cycle, which validate names on its own
    // pass. Every upward walk from the receiver re-enters it, so there
    // is no containment path at all — which must read as "nothing to
    // derive here", not as the no-common-ancestor error (Bugbot on
    // #125: an empty result set made that check vacuously true).
    const x = trackData('x', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const a = trackData('a', { inputs: [entry({ receive: 'verb' }), entry({ track: 'b' })] });
    const b = trackData('b', { inputs: [entry({ track: 'a' })] });
    const { cables, pushed } = run([x, a, b]);
    expect(pushed).toEqual([]);
    expect(cables).toEqual([]);
  });

  it('parallel mixes hearing identical arrivals agree (§19: the bed shape)', () => {
    const keys = trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const verse = trackData('verse', { inputs: [entry({ track: 'keys' })] });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const both = [entry({ track: 'verse', at: 3840 }), entry({ track: 'space' })];
    const main = trackData('main', { inputs: both });
    const bed = trackData('bed', { inputs: [...both] });
    const { cables, pushed } = run([keys, verse, space, main, bed]);
    expect(pushed).toEqual([]);
    expect(cables[0]!.arrivals).toEqual([96000]);
  });
});

describe('cables end to end (field check)', () => {
  it('a complete cable checks clean, warnings and all', async () => {
    track('keys', ['sends:', '  verb:', '    gain_db: -6']);
    track('verse', ['inputs:', '  - track: keys']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', [
      'inputs:',
      '  - track: verse',
      '  - track: verse',
      '    at: 7680',
      '  - track: space',
    ]);
    const { result, errors, warnings } = await messages();
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a bare label is a unity post-insert send', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const { result } = await messages();
    expect(result.ok).toBe(true);
  });

  it('a dangling send warns without failing check (§19 decision 3)', async () => {
    track('keys', ['sends:', '  verb:']);
    track('main', ['inputs:', '  - track: keys']);
    const { result, errors, warnings } = await messages();
    expect(errors).toEqual([]);
    expect(warnings.join()).toContain('send "verb" has no receive');
    expect(result.ok).toBe(true);
  });

  it('a dangling receive warns without failing check', async () => {
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: space']);
    const { result, warnings } = await messages();
    expect(warnings.join()).toContain('receive "verb" has no send');
    expect(result.ok).toBe(true);
  });

  it('two sends under one label is an error naming both files', async () => {
    track('keys', ['sends:', '  verb:']);
    track('pad', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: pad', '  - track: space']);
    const { result, errors } = await messages();
    expect(errors.join()).toContain('send "verb" is also declared in');
    expect(result.ok).toBe(false);
  });

  it('two receives under one label is an error', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('hall', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space', '  - track: hall']);
    const { errors } = await messages();
    expect(errors.join()).toContain('receive "verb" is also declared in');
  });

  it('a displaced receive path names the entry that carries the offset (§19 decision 4)', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', [
      'inputs:',
      '  - track: keys',
      '  - track: space',
      '    at: 3840',
    ]);
    const { errors } = await messages();
    expect(errors.join()).toContain('input 2 ("space") carries at');
    expect(errors.join()).toContain('single unshifted pass');
  });

  it('duration and fades stay legal on the receive path — non-displacing', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', [
      'inputs:',
      '  - track: keys',
      '  - track: space',
      '    duration: 3840',
      '    fade_out: 480',
    ]);
    const { result, errors } = await messages();
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a send cannot reach into itself (§1.7, its own message)', async () => {
    track('verse', ['sends:', '  verb:', 'inputs:', '  - track: space']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: verse']);
    const { errors } = await messages();
    expect(errors.join()).toContain('a send cannot reach into itself');
    expect(errors.join()).toContain('"space" is inside "verse"');
  });

  it('two cables closing a loop is a send cycle on the combined graph (§19 decision 8)', async () => {
    track('a', ['sends:', '  x:', 'inputs:', '  - receive: y']);
    track('b', ['sends:', '  y:', 'inputs:', '  - receive: x']);
    track('main', ['inputs:', '  - track: a', '  - track: b']);
    const { errors } = await messages();
    expect(errors.join()).toContain('send cycle:');
  });

  it('a cable whose ends share no ancestor is an error, not silence', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys']);
    // space is placed nowhere: no track contains both ends.
    const { errors } = await messages();
    expect(errors.join()).toContain('no track contains both');
  });

  it('containment paths that disagree on arrivals are an error naming the paths (§19 decision 5)', async () => {
    track('keys', ['sends:', '  verb:']);
    track('verse', ['inputs:', '  - track: keys']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: verse', '  - track: space']);
    track('alt', ['inputs:', '  - track: verse', '    at: 3840', '  - track: space']);
    const { errors } = await messages();
    expect(errors.join()).toContain('hears different arrivals');
    expect(errors.join()).toContain('[96000]');
    expect(errors.join()).toContain('[0]');
  });
});

describe('sends and receives in the schema', () => {
  it('an entry may not be a receive and a placement at once', async () => {
    track('space', ['inputs:', '  - receive: verb', '    track: keys']);
    const { errors } = await messages();
    expect(errors.join()).toContain('a receive admits signal, not a placement');
  });

  it('a receive carries no placement fields', async () => {
    track('space', ['inputs:', '  - receive: verb', '    at: 3840', '    gain_db: -3']);
    const { errors } = await messages();
    expect(errors.join()).toContain('remove at, gain_db');
  });

  it('the entry arity message names receive among the kinds', async () => {
    track('space', ['inputs:', '  - at: 0']);
    const { errors } = await messages();
    expect(errors.join()).toContain('or receive:');
  });

  it('fmt orders sends between inserts and inputs, values gain_db then tap', async () => {
    track('keys', [
      'inputs: []',
      'sends:',
      '  verb:',
      '    tap: pre',
      '    gain_db: -6',
    ]);
    const { formatted, errors } = fmt(root);
    expect(errors).toEqual([]);
    expect(formatted).toContain('songs/opener/tracks/keys.yaml');
    const text = readFileSync(join(root, 'songs/opener/tracks/keys.yaml'), 'utf8');
    expect(text).toBe(
      ['name: keys', 'sends:', '  verb:', '    gain_db: -6', '    tap: pre', 'inputs: []', ''].join(
        '\n',
      ),
    );
  });
});

describe('warnings hold no gate', () => {
  it('build proceeds under a warning and surfaces it (§19 chunk 4)', async () => {
    track('keys', ['sends:', '  verb:']);
    track('main', ['inputs:', '  - track: keys']);
    const warned: string[] = [];
    const outcomes = await buildLabels(
      root,
      ['//songs/opener/track:main'],
      undefined,
      (line) => warned.push(line),
    );
    expect(outcomes.length).toBeGreaterThan(0);
    expect(warned.join()).toContain('warning: send "verb" has no receive');
  });

  it('an error still refuses the build, warnings riding along in the report', async () => {
    track('keys', ['sends:', '  verb:', 'inputs:', '  - track: missing']);
    await expect(buildLabels(root, ['//songs/opener/track:keys'])).rejects.toThrow(
      'unknown track',
    );
  });

  it('fmt formats a project whose only diagnostics are warnings', async () => {
    track('keys', ['sends:', '  verb:', 'inputs: []']);
    // Not canonical: inputs before sends after fmt? Write misordered keys.
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      ['name: keys', 'inputs: []', 'sends:', '  verb:', ''].join('\n'),
    );
    const { formatted, errors } = fmt(root);
    expect(errors).toEqual([]);
    expect(formatted).toContain('songs/opener/tracks/keys.yaml');
  });
});
