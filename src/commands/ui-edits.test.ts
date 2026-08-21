import { describe, expect, it } from 'vitest';
import type { InputEntry } from '../schema/index.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import {
  applyEdit,
  applyInsertAdd,
  applyInsertEdit,
  applyInsertRemove,
  applyMove,
  applySplit,
} from './ui-edits.js';

// The socket's writes land in files the author also edits by hand, so
// the standard is not "does it parse" but "is it what a person would
// have typed". Every test here writes and compares text, because both
// defects this surface has produced — a comment deleted by a move, a
// default hardcoded beside a block that derives them — were invisible
// to a typecheck and survived a build (#163 review).

const track = (lines: string[]) => lines.join('\n') + '\n';

describe('placement edits', () => {
  it('writes a set value and deletes a default, leaving the file minimal', () => {
    const raw = track(['name: main', 'inputs:', '  - track: bass']);
    const on = applyEdit(raw, 0, { mute: true });
    if (!on.ok) throw new Error(on.message);
    expect(on.text).toContain('mute: true');
    const off = applyEdit(on.text, 0, { mute: false });
    if (!off.ok) throw new Error(off.message);
    expect(off.text).toBe(raw); // byte-identical: the default never lands
  });

  it('keeps the comment on a line it edits', () => {
    const raw = track(['name: main', 'inputs:', '  - track: bass', '    gain_db: -2 # trimmed for the vocal']);
    const result = applyEdit(raw, 0, { gain_db: -3 });
    if (!result.ok) throw new Error(result.message);
    expect(result.text).toContain('gain_db: -3 # trimmed for the vocal');
  });
});

describe('placement moves', () => {
  const tempo = new TempoMap([{ at: 0, bpm: 120 }], 48000);
  const meter = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
  const barSamples = 96000; // one 4/4 bar at 120 BPM, 48 kHz
  const entry = (at: number) => ({ track: 'hats', at, anchor: 'musical' }) as InputEntry;

  it('keeps a musical array spelling, and the comment on its line', () => {
    const raw = track(['name: drums', 'inputs:', '  - track: hats', '    at: [2] # pickup wants the second bar']);
    const barTicks = tempo.samplesToTicks(barSamples);
    const moved = applyMove(raw, 0, entry(barTicks), barSamples, tempo, meter);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.text).toContain('at: [3] # pickup wants the second bar');
    const back = applyMove(moved.text, 0, entry(barTicks * 2), -barSamples, tempo, meter);
    if (!back.ok) throw new Error(back.message);
    expect(back.text).toBe(raw); // the round trip returns the author's bytes
  });

  it('writes ticks for a scalar spelling and deletes at zero', () => {
    const raw = track(['name: drums', 'inputs:', '  - track: hats']);
    const moved = applyMove(raw, 0, entry(0), barSamples, tempo, meter);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.text).toContain(`at: ${tempo.samplesToTicks(barSamples)}`);
    const back = applyMove(moved.text, 0, entry(tempo.samplesToTicks(barSamples)), -barSamples, tempo, meter);
    if (!back.ok) throw new Error(back.message);
    expect(back.text).toBe(raw);
  });

  it('writes samples directly on an absolute anchor', () => {
    const raw = track(['name: drums', 'inputs:', '  - audio: hit', '    anchor: absolute']);
    const abs = { audio: 'hit', at: 0, anchor: 'absolute' } as InputEntry;
    const moved = applyMove(raw, 0, abs, 12345, tempo, meter);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.text).toContain('at: 12345');
  });
});

describe('placement splits', () => {
  const tempo = new TempoMap([{ at: 0, bpm: 120 }], 48000);
  const meter = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
  const barSamples = 96000; // one 4/4 bar at 120 BPM, 48 kHz
  const barTicks = 3840;
  const full = (over: Record<string, unknown>) =>
    ({
      at: 0, anchor: 'musical', source_offset: 0, slip: 0,
      gain_db: 0, pan: 0, mute: false, fade_in: 0, fade_out: 0,
      ...over,
    }) as unknown as InputEntry;

  it('cuts a windowed musical clip into two that add back up', () => {
    const raw = track(['name: main', 'inputs:', '  - audio: riff', `    duration: ${barTicks * 2}`]);
    const parsed = full({ audio: 'riff', duration: barTicks * 2 });
    const result = applySplit(raw, 0, parsed, barSamples, tempo, meter);
    if (!result.ok) throw new Error(result.message);
    expect(result.text).toBe(
      track([
        'name: main',
        'inputs:',
        '  - audio: riff',
        `    duration: ${barTicks}`,
        '  - audio: riff',
        `    at: ${barTicks}`,
        `    duration: ${barTicks}`,
        `    source_offset: ${barSamples}`,
      ]),
    );
  });

  it('keeps the at spelling and comments, and leaves an open window open', () => {
    const raw = track([
      'name: main',
      'inputs:',
      '  - audio: riff',
      '    at: [2] # the pickup',
      '    gain_db: -3 # trimmed',
    ]);
    const parsed = full({ audio: 'riff', at: barTicks, gain_db: -3 });
    const result = applySplit(raw, 0, parsed, barSamples / 2, tempo, meter);
    if (!result.ok) throw new Error(result.message);
    // Second half: bar 2 beat 3, spelled musically, comment carried;
    // the clone keeps the gain comment on both halves. The first half
    // gains the cut as its duration; the second stays an open window —
    // it plays to the source's end from its advanced offset.
    expect(result.text).toContain('at: [2] # the pickup');
    expect(result.text).toContain('at: [2, 3] # the pickup');
    expect(result.text.match(/gain_db: -3 # trimmed/g)).toHaveLength(2);
    expect(result.text).toContain(`source_offset: ${barSamples / 2}`);
    expect(result.text.match(/duration:/g)).toHaveLength(1); // the first half's cut
  });

  it('splits an absolute clip in samples, and hands the fades to their halves', () => {
    const raw = track([
      'name: main', 'inputs:', '  - audio: hit', '    anchor: absolute', '    at: 1000',
      '    duration: 5000', '    fade_in: 10', '    fade_out: 20', '    id: whack',
    ]);
    const parsed = full({
      audio: 'hit', anchor: 'absolute', at: 1000, duration: 5000,
      fade_in: 10, fade_out: 20, id: 'whack',
    });
    const result = applySplit(raw, 0, parsed, 2000, tempo, meter);
    if (!result.ok) throw new Error(result.message);
    // The whole file, canonical order: the id stays with the first
    // half, the fades go to their halves, the source picks up where
    // the cut left off.
    expect(result.text).toBe(
      track([
        'name: main',
        'inputs:',
        '  - id: whack',
        '    audio: hit',
        '    anchor: absolute',
        '    at: 1000',
        '    duration: 2000',
        '    fade_in: 10',
        '  - audio: hit',
        '    anchor: absolute',
        '    at: 3000',
        '    duration: 3000',
        '    source_offset: 2000',
        '    fade_out: 20',
      ]),
    );
  });

  it('keeps a span spelling for duration, and its comment, on both halves', () => {
    // bloom's lead-vocal authors exactly this: a beats span with a
    // sentence explaining why. A split must not cost the sentence.
    const raw = track([
      'name: main',
      'inputs:',
      '  - audio: take',
      '    duration: [0, 8] # eight beats — room for any take, not just this one',
    ]);
    const parsed = full({ audio: 'take', duration: 8 * 960 });
    // Three beats in: 2880 ticks, 72000 samples at 120 BPM / 48 kHz.
    const result = applySplit(raw, 0, parsed, 72000, tempo, meter);
    if (!result.ok) throw new Error(result.message);
    expect(result.text).toBe(
      track([
        'name: main',
        'inputs:',
        '  - audio: take',
        '    duration: [0, 3] # eight beats — room for any take, not just this one',
        '  - audio: take',
        '    at: 2880',
        '    duration: [1, 1] # eight beats — room for any take, not just this one',
        '    source_offset: 72000',
      ]),
    );
  });

  it('refuses a cut past the clip end', () => {
    const raw = track(['name: main', 'inputs:', '  - audio: riff', `    duration: ${barTicks}`]);
    const parsed = full({ audio: 'riff', duration: barTicks });
    const result = applySplit(raw, 0, parsed, barSamples * 2, tempo, meter);
    expect(result.ok).toBe(false);
  });
});

describe('insert ops', () => {
  it('adds an effect in its minimal spelling', () => {
    const raw = track(['name: bass', 'inputs:', '  - audio: bass']);
    const result = applyInsertAdd(raw, 'limit');
    if (!result.ok) throw new Error(result.message);
    expect(result.text).toContain('inserts:\n  - effect: limit\n');
    expect(result.text).not.toContain('ceiling_db'); // defaults stay implicit
  });

  it('adds the eq as the Fyra layout, flat and minimal', () => {
    const raw = track(['name: bass', 'inputs:', '  - audio: bass']);
    const result = applyInsertAdd(raw, 'eq');
    if (!result.ok) throw new Error(result.message);
    expect(result.text.match(/frequency:/g)).toHaveLength(6);
    expect(result.text).not.toContain('gain_db'); // flat: no band moved yet
    expect(result.text).not.toContain('bandwidth');
  });

  it('appends to an existing chain rather than replacing it', () => {
    const raw = track(['name: bass', 'inserts:', '  - effect: limit', 'inputs:', '  - audio: bass']);
    const result = applyInsertAdd(raw, 'reverb');
    if (!result.ok) throw new Error(result.message);
    expect(result.text.indexOf('effect: limit')).toBeLessThan(result.text.indexOf('effect: reverb'));
  });

  it('writes an off-default parameter and deletes one set back to default', () => {
    const raw = track(['name: bass', 'inserts:', '  - effect: reverb', 'inputs:', '  - audio: bass']);
    const wet = applyInsertEdit(raw, 0, { mix: 0.5 });
    if (!wet.ok) throw new Error(wet.message);
    expect(wet.text).toContain('mix: 0.5');
    const dry = applyInsertEdit(wet.text, 0, { mix: 0.3 }); // 0.3 is the schema default
    if (!dry.ok) throw new Error(dry.message);
    expect(dry.text).toBe(raw);
  });

  it('re-spells bands minimally with defaults derived from the schema', () => {
    const raw = track([
      'name: bass',
      'inserts:',
      '  - effect: eq',
      '    bands:',
      '      - type: bell',
      '        frequency: 220',
      'inputs:',
      '  - audio: bass',
    ]);
    const boosted = applyInsertEdit(raw, 0, {
      bands: [{ type: 'bell', frequency: 220, gain_db: 4, bandwidth: 2 }],
    });
    if (!boosted.ok) throw new Error(boosted.message);
    expect(boosted.text).toContain('gain_db: 4');
    expect(boosted.text).not.toContain('bandwidth'); // 2 is the band default
    const flat = applyInsertEdit(boosted.text, 0, {
      bands: [{ type: 'bell', frequency: 220, gain_db: 0, bandwidth: 2 }],
    });
    if (!flat.ok) throw new Error(flat.message);
    expect(flat.text).toBe(raw);
  });

  it('rejects a parameter the schema would refuse', () => {
    const raw = track(['name: bass', 'inserts:', '  - effect: reverb', 'inputs:', '  - audio: bass']);
    const result = applyInsertEdit(raw, 0, { mix: 2 });
    expect(result.ok).toBe(false);
  });

  it('removes an insert, and the emptied chain loses its key', () => {
    const raw = track(['name: bass', 'inserts:', '  - effect: limit', 'inputs:', '  - audio: bass']);
    const result = applyInsertRemove(raw, 0);
    if (!result.ok) throw new Error(result.message);
    expect(result.text).not.toContain('inserts');
    expect(result.text).toBe(track(['name: bass', 'inputs:', '  - audio: bass']));
  });
});
