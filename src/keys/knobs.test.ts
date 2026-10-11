import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { Knob } from '../schema/knobs.js';
import {
  controllerOf,
  formatKnobValue,
  knobFileFor,
  knobFileName,
  knobList,
  knobsCopy,
  knobValue,
  knobValueWidth,
  KnobsError,
  loadKnobs,
  MOD_KNOB,
  parseKnobs,
  resolveKnobsPath,
  stepFrom,
} from './knobs.js';

const shelf = join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments');
const juno = loadKnobs(join(shelf, 'juno.knobs.yaml'));
const knob = (name: string): Knob => juno.find((k) => k.name === name)!;

// Every value a knob prints, at every controller value.
function printed(k: Knob): string[] {
  return Array.from({ length: 128 }, (_, cc) => formatKnobValue(k, knobValue(k, cc)));
}

describe('finding knob files', () => {
  it('finds an instrument’s knob file beside its program', () => {
    expect(knobFileFor('/p/shared/instruments/juno.scd')).toBe('/p/shared/instruments/juno.knobs.yaml');
    expect(knobFileFor('/p/pad.v2.scd')).toBe('/p/pad.v2.knobs.yaml');
  });

  it('resolves --knobs by bare name on the shelf, and by path', () => {
    expect(resolveKnobsPath('juno', '/p')).toBe('/p/shared/instruments/juno.knobs.yaml');
    expect(resolveKnobsPath('~/knobs/ju-06a.yaml', '/p', { home: '/home/j' })).toBe('/home/j/knobs/ju-06a.yaml');
    expect(resolveKnobsPath('ju-06a.yaml', undefined, { cwd: '/here' })).toBe('/here/ju-06a.yaml');
    expect(resolveKnobsPath('./k', undefined, { cwd: '/here' })).toBe('/here/k');
    expect(() => resolveKnobsPath('juno', undefined)).toThrow(/not inside a Field project/);
  });

  it('names a knob file’s knobs after the file', () => {
    expect(knobFileName('/p/juno.knobs.yaml')).toBe('juno');
    expect(knobFileName('/home/j/knobs/ju-06a.yaml')).toBe('ju-06a');
  });
});

describe('reading knob files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-knobs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('names every problem with the file', () => {
    const path = join(dir, 'bad.knobs.yaml');
    writeFileSync(path, 'knobs:\n  - { name: a, cc: 1 }\n  - { name: b, cc: 20, min: 0, max: 0 }\n');
    expect(() => loadKnobs(path)).toThrow(KnobsError);
    try {
      loadKnobs(path);
    } catch (err) {
      expect((err as KnobsError).problems).toEqual([
        'knobs.0.cc: a: cc 1 is the modulation wheel, which is the knob mod',
        'knobs.1.max: b: min and max are both 0, so the knob has nowhere to turn',
      ]);
    }
    expect(() => loadKnobs(join(dir, 'missing.yaml'))).toThrow(/no such file/);
    expect(() => parseKnobs('knobs: [', 'x.yaml')).toThrow(KnobsError);
  });

  it('writes a copy with every field spelled out, which reads back the same', () => {
    const copy = knobsCopy(parseKnobs('knobs:\n  - { name: tone, cc: 20 }\n', 'k.yaml'));
    expect(parseDocument(copy).toJS()).toEqual({ knobs: [{ name: 'tone', cc: 20, min: 0, max: 127, curve: 'lin', step: 0, default: 0 }] });
    expect(parseKnobs(knobsCopy(juno), 'copy.yaml')).toEqual(juno);
  });
});

describe('the knob list', () => {
  it('puts mod first, then each source’s knobs, named after their source when there are several', () => {
    expect(knobList([{ name: 'juno', knobs: juno }]).map((k) => k.label)).toEqual(['mod', 'cutoff', 'res', 'attack', 'release']);
    expect(knobList([]).map((k) => k.label)).toEqual(['mod']);
    const both = knobList([
      { name: 'keys', knobs: juno.slice(0, 1) },
      { name: 'bass', knobs: juno.slice(0, 1) },
    ]);
    expect(both.map((k) => k.label)).toEqual(['mod', 'keys.cutoff', 'bass.cutoff']);
    expect(both[0]!.knob).toBe(MOD_KNOB);
  });
});

describe('controller values', () => {
  it('maps a controller value as ControlSpec.map does', () => {
    // ControlSpec(50, 15000, \exp).map(62 / 127) in SuperCollider 3.14.1.
    expect(knobValue(knob('cutoff'), 62)).toBeCloseTo(809.6052, 3);
    expect(knobValue(knob('cutoff'), 0)).toBeCloseTo(50);
    expect(knobValue(knob('cutoff'), 127)).toBeCloseTo(15000);
    expect(knobValue(knob('res'), 127)).toBeCloseTo(0.95);
    expect(knobValue({ ...MOD_KNOB, max: 10, step: 1 }, 64)).toBe(5);
  });

  it('starts a knob from its default, unmapped and rounded', () => {
    // ControlSpec(50, 15000, \exp).unmap(2000) is 0.6467, so 82.
    expect(controllerOf(knob('cutoff'), 2000)).toBe(82);
    expect(controllerOf(knob('res'), 0.3)).toBe(40);
    expect(controllerOf(MOD_KNOB, 0)).toBe(0);
  });

  it('steps one controller value, and stops at either end', () => {
    expect(stepFrom(knob('cutoff'), 82, 1)).toBe(83);
    expect(stepFrom(knob('cutoff'), 82, -1)).toBe(81);
    expect(stepFrom(knob('cutoff'), 127, 1)).toBe(127);
    expect(stepFrom(knob('cutoff'), 0, -1)).toBe(0);
  });

  it('steps a knob with a step to the next value that maps differently', () => {
    const toggle: Knob = { name: 'chorus', cc: 20, min: 0, max: 1, curve: 'lin', step: 1, default: 0 };
    expect(stepFrom(toggle, 0, 1)).toBe(64);
    expect(stepFrom(toggle, 64, 1)).toBe(64);
    expect(stepFrom(toggle, 64, -1)).toBe(63);
    expect(knobValue(toggle, 63)).toBe(0);
  });
});

describe('printing a value', () => {
  it('prints an exp knob to three significant digits, with k and m', () => {
    expect(formatKnobValue(knob('cutoff'), 2000)).toBe('2.00 kHz');
    expect(formatKnobValue(knob('cutoff'), knobValue(knob('cutoff'), 62))).toBe('810 Hz');
    expect(formatKnobValue(knob('cutoff'), 15000)).toBe('15.0 kHz');
    expect(formatKnobValue(knob('cutoff'), 50)).toBe('50.0 Hz');
    expect(formatKnobValue(knob('cutoff'), 999.9)).toBe('1.00 kHz');
    expect(formatKnobValue(knob('attack'), 0.8)).toBe('800 ms');
    expect(formatKnobValue(knob('attack'), 0.005)).toBe('5.00 ms');
    expect(formatKnobValue(knob('attack'), 0.9999)).toBe('1.00 s');
    expect(formatKnobValue(knob('release'), 1.5)).toBe('1.50 s');
    expect(formatKnobValue({ ...knob('cutoff'), units: undefined }, 2000)).toBe('2.00k');
  });

  it('prints a lin knob with the places its far end needs, and whole knobs whole', () => {
    expect(printed(knob('res'))[0]).toBe('0.000');
    expect(printed(knob('res'))[127]).toBe('0.950');
    expect(formatKnobValue(knob('res'), 0.3)).toBe('0.300');
    expect(printed(MOD_KNOB).slice(0, 3)).toEqual(['0', '1', '2']);
    expect(formatKnobValue({ name: 'p', cc: 20, min: -1, max: 1, curve: 'lin', step: 0, default: 0 }, -0.0001)).toBe('0.00');
  });

  it('gives each knob one width across its default and all its values', () => {
    expect(knobValueWidth(MOD_KNOB)).toBe(3);
    expect(knobValueWidth(knob('cutoff'))).toBe(8);
    expect(knobValueWidth(knob('res'))).toBe(5);
    expect(knobValueWidth(knob('attack'))).toBe(7);
    expect(knobValueWidth(knob('release'))).toBe(7);
  });
});
