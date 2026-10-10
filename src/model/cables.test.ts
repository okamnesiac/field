import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../commands/init.js';
import { createSong } from '../commands/create.js';
import { check } from '../commands/check.js';
import { fmt } from '../commands/fmt.js';
import { buildLabels, explainLabel, queryDeps } from '../commands/build.js';
import { importAsset } from '../commands/import.js';
import { readWav, writeWavFloat32 } from '../audio/wav.js';
import type { GeneratorRunner } from '../graph/build.js';
import type { StemSpec } from '../generators/stem.js';
import { formatLabel } from '../labels.js';
import { TempoMap } from '../time/tempo.js';
import { trackOrder, type InputEntry, type Track } from '../schema/index.js';
import type { LoadedFile } from './project.js';
import { checkCables, formatCable, type TrackClock } from './cables.js';

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
  mute: false,
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

// Most arrivals are single landings; the counted shape exists for
// identical placements summing together.
const at = (...offsets: number[]) => offsets.map((o) => ({ at: o, count: 1 }));

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
    expect(cables[0]!.arrivals).toEqual(at(96000, 288000));
  });

  it('a muted sender placement sends nothing, and an all-muted cable is silent, not dangling', () => {
    // A muted placement is absent from the mix, sends included: muting
    // the second verse drops its arrival, and muting both leaves the
    // cable joined with nothing arriving — no "never arrives" error.
    const keys = trackData('keys', { sends: { verb: { gain_db: -6, tap: 'post' } } });
    const verse = trackData('verse', { inputs: [entry({ track: 'keys', at: 3840 })] });
    const space = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    const main = (mute: [boolean, boolean]) =>
      trackData('main', {
        inputs: [
          entry({ track: 'verse', mute: mute[0] }),
          entry({ track: 'verse', at: 7680, mute: mute[1] }),
          entry({ track: 'space' }),
        ],
      });
    const one = run([keys, verse, space, main([false, true])]);
    expect(one.pushed).toEqual([]);
    expect(one.cables[0]!.arrivals).toEqual(at(96000));
    const none = run([keys, verse, space, main([true, true])]);
    expect(none.pushed).toEqual([]);
    expect(none.cables).toHaveLength(1);
    expect(none.cables[0]!.arrivals).toEqual([]);
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
    expect(cables[0]!.arrivals).toEqual(at(0, 96000));
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
    expect(cables[0]!.arrivals).toEqual(at(4800));
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
    expect(cables[0]!.arrivals).toEqual(at(96000));
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
    expect(cables[0]!.arrivals).toEqual(at(192000));
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
    expect(cables[0]!.arrivals).toEqual(at(24000));
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

  it('a return carrying its own dry copy of the sender hears it at zero and through the mix (#125 review)', () => {
    // keys sounds twice — at 0 inside the return itself, and at bar 2
    // inside verse — and both are derivable, so both arrive. The old
    // walk stopped at the lowest containing ancestor and silently
    // dropped the verse sounding.
    const keys = trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } });
    const space = trackData('space', {
      inputs: [entry({ receive: 'verb' }), entry({ track: 'keys' })],
    });
    const verse = trackData('verse', { inputs: [entry({ track: 'keys', at: 3840 })] });
    const main = trackData('main', {
      inputs: [entry({ track: 'verse' }), entry({ track: 'space' })],
    });
    const { cables, pushed } = run([keys, space, verse, main]);
    expect(pushed).toEqual([]);
    expect(cables[0]!.arrivals).toEqual(at(0, 96000));
    // Deleting the dry line removes exactly its arrival — adding a dry
    // copy must never *remove* one.
    const bare = trackData('space', { inputs: [entry({ receive: 'verb' })] });
    expect(run([keys, bare, verse, main]).cables[0]!.arrivals).toEqual(at(96000));
  });

  it('shared placements cost the graph, not the number of paths through it (#125 review)', () => {
    // A lattice with two tracks per level, each placed in both tracks of
    // the level above: 2^depth upward paths from the receiver. The old
    // walk enumerated all of them; the memoized one answers per track.
    const depth = 22;
    const tracks: Track[] = [
      trackData('keys', { sends: { verb: { gain_db: 0, tap: 'post' } } }),
      trackData('space', { inputs: [entry({ receive: 'verb' })] }),
      trackData('l0-a', { inputs: [entry({ track: 'keys' }), entry({ track: 'space' })] }),
      trackData('l0-b', { inputs: [entry({ track: 'keys' }), entry({ track: 'space' })] }),
    ];
    for (let level = 1; level <= depth; level++) {
      for (const side of ['a', 'b']) {
        tracks.push(
          trackData(`l${level}-${side}`, {
            inputs: [entry({ track: `l${level - 1}-a` }), entry({ track: `l${level - 1}-b` })],
          }),
        );
      }
    }
    const started = Date.now();
    const { cables, pushed } = run(tracks);
    const elapsed = Date.now() - started;
    expect(pushed).toEqual([]);
    expect(cables).toHaveLength(1);
    // Every level doubles the sender's soundings (both subtrees carry
    // it), so the count is real — 2^22 identical landings at zero —
    // and the counted shape is what holds it as one row.
    expect(cables[0]!.arrivals).toEqual([{ at: 0, count: 2 ** depth }]);
    // The old walk took ~7 s at this depth; the memoized one is
    // bounded far below any flake margin.
    expect(elapsed).toBeLessThan(3000);
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
    expect(cables[0]!.arrivals).toEqual(at(96000));
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

  it('a receive declared twice in one file says so, not "also declared in <this file>" (#125 review)', async () => {
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const { errors } = await messages();
    expect(errors.join()).toContain('receive "verb" is declared twice in this file');
    expect(errors.join()).not.toContain('also declared in');
  });

  it('a track sending to its own receive gets its own sentence (#125 review)', async () => {
    track('verse', ['sends:', '  verb:', 'inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: verse']);
    const { errors } = await messages();
    expect(errors.join()).toContain('"verse" both sends and receives "verb"');
    expect(errors.join()).toContain('not a destination');
    expect(errors.join()).not.toContain('is inside "verse"');
  });

  it('displacing a return does not silence the divergence error (#125 review, round 2)', async () => {
    // bed hears no keys; main does. Undisplaced, that diverges and
    // errors. Displacing bed's placement changes nothing about what
    // the two mixes hear — the displaced edge contributes the empty
    // set and must still be compared, not skipped.
    track('keys', ['sends:', '  verb:']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    track('bed', ['inputs:', '  - track: space', '    at: 3840']);
    const { result, errors } = await messages();
    expect(errors.join()).toContain('hears different arrivals');
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

describe('cables render (nested-tracks.md §19 chunk 4)', () => {
  const captureRunner = (specs: Record<string, unknown>): GeneratorRunner =>
    async (node, _inputs, outputPath) => {
      specs[formatLabel(node.label)] = node.spec;
      writeFileSync(outputPath, JSON.stringify(node.spec));
    };

  it('the receiver consumes the sender stem and sums it at each arrival', async () => {
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
    expect(queryDeps(root, 'deps(//songs/opener/track:space)')).toContain(
      '//songs/opener/track:keys',
    );
    const specs: Record<string, unknown> = {};
    await buildLabels(root, ['//songs/opener/track:space'], captureRunner(specs));
    const spec = specs['//songs/opener/track:space'] as StemSpec;
    expect(spec.sources).toEqual(['track:keys']);
    // verse at 0 and at bar 3 (7680 ticks = 192000 samples), keys at 0
    // inside it: two arrivals, the sender's whole render at −6 dB each.
    expect(spec.clips).toEqual([
      { input: 0, start: 0, read_offset: 0, gain_db: -6, fade_in: 0, fade_out: 0 },
      { input: 0, start: 192000, read_offset: 0, gain_db: -6, fade_in: 0, fade_out: 0 },
    ]);
  });

  it('a muted sender placement leaves the receiver, in the plan and in the deps', async () => {
    track('keys', ['sends:', '  verb:', '    gain_db: -6']);
    track('verse', ['inputs:', '  - track: keys']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', [
      'inputs:',
      '  - track: verse',
      '    mute: true',
      '  - track: verse',
      '    at: 7680',
      '  - track: space',
    ]);
    const specs: Record<string, unknown> = {};
    await buildLabels(root, ['//songs/opener/track:space'], captureRunner(specs));
    // Only the unmuted verse at bar 3 arrives.
    expect((specs['//songs/opener/track:space'] as StemSpec).clips).toEqual([
      { input: 0, start: 192000, read_offset: 0, gain_db: -6, fade_in: 0, fade_out: 0 },
    ]);
    // Both muted: the cable is joined but silent — no error, and the
    // receiver no longer depends on the sender at all.
    track('main', [
      'inputs:',
      '  - track: verse',
      '    mute: true',
      '  - track: verse',
      '    at: 7680',
      '    mute: true',
      '  - track: space',
    ]);
    expect((await messages()).errors).toEqual([]);
    expect(queryDeps(root, 'deps(//songs/opener/track:space)')).not.toContain('//songs/opener/track:keys');
  });

  it('tap: pre consumes a pre-insert tap node instead of the stem', async () => {
    track('keys', [
      'inserts:',
      '  - effect: eq',
      '    bands:',
      '      - type: lowpass',
      '        frequency: 700',
      'sends:',
      '  verb:',
      '    tap: pre',
    ]);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const deps = queryDeps(root, 'deps(//songs/opener/track:space)');
    expect(deps).toContain('//songs/opener/tap:keys');
    expect(deps).not.toContain('//songs/opener/track:keys');
    const specs: Record<string, unknown> = {};
    await buildLabels(root, ['//songs/opener/track:space'], captureRunner(specs));
    const tap = specs['//songs/opener/tap:keys'] as StemSpec;
    const stem = specs['//songs/opener/track:space'] as StemSpec;
    // The tap is the sender's plan minus its inserts — same clips, no
    // inserts key — and the receiver wires the tap, not the stem.
    expect(tap.inserts).toBeUndefined();
    expect(stem.sources).toEqual(['tap:keys']);
  });

  it('a sender at another rate converts at the cable edge (multi-rate.md decision 4)', async () => {
    track('keys', ['rate: 44100']);
    track('space', ['inputs:', '  - receive: verb']);
    // The send rides the sender file; declared after rate to stay canonical.
    writeFileSync(
      join(root, 'songs/opener/tracks/keys.yaml'),
      ['name: keys', 'rate: 44100', 'sends:', '  verb:', ''].join('\n'),
    );
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const deps = queryDeps(root, 'deps(//songs/opener/track:space)');
    expect(deps).toContain('//songs/opener/convert:track-keys-48000');
  });

  it('a gain tweak re-keys the receiver and only the receiver', async () => {
    track('keys', ['sends:', '  verb:', '    gain_db: -6']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const ran: string[] = [];
    const runner: GeneratorRunner = async (node, _inputs, outputPath) => {
      ran.push(formatLabel(node.label));
      writeFileSync(outputPath, JSON.stringify(node.spec));
    };
    await buildLabels(root, ['//songs/opener/track:space'], runner);
    expect(ran).toEqual(['//songs/opener/track:keys', '//songs/opener/track:space']);
    ran.length = 0;
    track('keys', ['sends:', '  verb:', '    gain_db: -3']);
    await buildLabels(root, ['//songs/opener/track:space'], runner);
    // The sender's own render saw nothing change; the receive's clips did.
    expect(ran).toEqual(['//songs/opener/track:space']);
  });

  it('the summed audio is real: an impulse arrives where the walk said (daemon render)', async () => {
    // A one-frame impulse at the head of a one-beat asset, sent from a
    // leaf placed at bar 1 — the receiver's render must carry it at
    // sample 96000, scaled by the cable's −6 dB.
    const src = join(root, '..', `field-cable-src-${Date.now()}.wav`);
    const samples = new Float32Array(24000);
    samples[0] = 1;
    writeWavFloat32(src, 48000, [samples]);
    await importAsset(root, 'opener', src, 'hit');
    rmSync(src);
    track('kick', ['sends:', '  verb:', '    gain_db: -6', 'inputs:', '  - audio: hit']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: kick', '    at: 3840', '  - track: space']);
    const outcomes = await buildLabels(root, ['//songs/opener/track:space']);
    const out = outcomes.find((o) => o.label === '//songs/opener/track:space')!;
    const audio = readWav(out.outputPath!);
    const gain = Math.pow(10, -6 / 20);
    expect(audio.channels[0]![96000]).toBeCloseTo(gain, 5);
    expect(audio.channels[0]![0]).toBe(0);
  });

  it('a pre tap of the output track keeps the song extent (#126 review)', async () => {
    // The extent is content, not an insert: a pre tap of `main` must
    // truncate and fold exactly as the stem does, differing only by
    // the inserts it omits.
    writeFileSync(
      join(root, 'songs/opener/song.yaml'),
      [
        'name: opener',
        'length: 3840',
        'time:',
        '  tempo:',
        '    - at: 0',
        '      bpm: 120',
        '  meter:',
        '    - at: 0',
        '      numerator: 4',
        '      denominator: 4',
        '',
      ].join('\n'),
    );
    track('main', [
      'sends:',
      '  verb:',
      '    tap: pre',
      'inserts:',
      '  - effect: limit',
    ]);
    track('space', ['inputs:', '  - receive: verb']);
    track('album', ['inputs:', '  - track: main', '  - track: space']);
    const specs: Record<string, unknown> = {};
    await buildLabels(root, ['//songs/opener/track:space'], captureRunner(specs));
    const tap = specs['//songs/opener/tap:main'] as StemSpec;
    expect(tap.inserts).toBeUndefined();
    expect(tap.length_samples).toBe(96000);
  });

  it('a tap node answers no level question — that answer is the track stem alone (#126 review)', async () => {
    track('keys', [
      'inserts:',
      '  - effect: eq',
      '    bands:',
      '      - type: lowpass',
      '        frequency: 700',
      'sends:',
      '  verb:',
      '    tap: pre',
    ]);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    // A tap travels nowhere but its cable; the sender's placement path
    // is the stem's answer, and repeating it here would be confidently
    // wrong about where the pre signal goes.
    const tap = await explainLabel(root, '//songs/opener/tap:keys');
    expect(tap.levels).toBeUndefined();
    const stem = await explainLabel(root, '//songs/opener/track:keys');
    expect(stem.levels?.cables).toHaveLength(1);
  });

  it('explain shows the cable from either end', async () => {
    track('keys', ['sends:', '  verb:', '    gain_db: -6']);
    track('space', ['inputs:', '  - receive: verb']);
    track('main', ['inputs:', '  - track: keys', '  - track: space']);
    const sender = await explainLabel(root, '//songs/opener/track:keys');
    const receiver = await explainLabel(root, '//songs/opener/track:space');
    expect(sender.levels?.cables).toHaveLength(1);
    const cable = receiver.levels!.cables[0]!;
    expect(formatCable(cable, 'keys')).toBe('send "verb" → track:space, -6.0 dB (tap post)');
    expect(formatCable(cable, 'space')).toBe(
      'receive "verb" ← track:keys, -6.0 dB (tap post), arrives at sample 0',
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
