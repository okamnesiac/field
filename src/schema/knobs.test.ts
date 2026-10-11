import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { knobFileSchema } from './knobs.js';

const shelf = join(import.meta.dirname, '..', '..', 'examples', 'bloom', 'shared', 'instruments');

function problems(knobs: unknown[]): string[] {
  const parsed = knobFileSchema.safeParse({ knobs });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('the knob file schema', () => {
  it("accepts juno's and bass's files", () => {
    for (const file of ['juno.knobs.yaml', 'bass.knobs.yaml']) {
      const parsed = knobFileSchema.safeParse(parseDocument(readFileSync(join(shelf, file), 'utf8')).toJS());
      expect(parsed.success, file).toBe(true);
    }
  });

  it('fills min, max, curve, step, and default', () => {
    expect(knobFileSchema.parse({ knobs: [{ name: 'tone', cc: 20 }] }).knobs[0]).toEqual({
      name: 'tone',
      cc: 20,
      min: 0,
      max: 127,
      curve: 'lin',
      step: 0,
      default: 0,
    });
    expect(knobFileSchema.parse({ knobs: [{ name: 'tone', cc: 20, min: 5, max: 9 }] }).knobs[0]!.default).toBe(5);
  });

  it('accepts a default at either end of its range, and a range that runs downward', () => {
    expect(problems([{ name: 'attack', cc: 73, min: 0.005, max: 4, curve: 'exp', default: 0.005 }])).toEqual([]);
    expect(problems([{ name: 'a', cc: 20, min: 10, max: 0, default: 10 }])).toEqual([]);
  });

  it('rejects a repeated name or controller, and a knob named mod', () => {
    expect(problems([{ name: 'a', cc: 20 }, { name: 'a', cc: 21 }])).toEqual(['a: appears twice; a name names one knob']);
    expect(problems([{ name: 'a', cc: 20 }, { name: 'b', cc: 20 }])).toEqual(['b: cc 20 turns another knob in this file']);
    expect(problems([{ name: 'mod', cc: 20 }])).toEqual(['mod: mod is the modulation wheel, the knob field keys always shows first']);
  });

  it('rejects a controller that is reserved, a channel mode message, or not a controller', () => {
    expect(problems([{ name: 'a', cc: 1 }])).toEqual(['a: cc 1 is the modulation wheel, which is the knob mod']);
    for (const cc of [0, 6, 32, 38, 64, 96, 97, 98, 99, 100, 101]) expect(problems([{ name: 'a', cc }]), String(cc)).toHaveLength(1);
    expect(problems([{ name: 'a', cc: 120 }])).toEqual(['a: cc 120 is a channel mode message']);
    expect(problems([{ name: 'a', cc: 128 }])).toEqual(['a: cc 128 is not a MIDI controller, which runs from 0 to 127']);
    for (const cc of [2, 5, 7, 31, 33, 63, 65, 95, 102, 119]) expect(problems([{ name: 'a', cc }]), String(cc)).toEqual([]);
  });

  it('rejects an exp range that touches or crosses 0, equal min and max, and a default outside the range', () => {
    expect(problems([{ name: 'a', cc: 20, min: 0, max: 1, curve: 'exp', default: 0.5 }])).toEqual([
      'a: an exp curve needs min and max of one sign and neither 0, not 0 and 1',
    ]);
    expect(problems([{ name: 'a', cc: 20, min: -1, max: 1, curve: 'exp', default: 0.5 }])).toHaveLength(1);
    expect(problems([{ name: 'a', cc: 20, min: -10, max: -1, curve: 'exp', default: -5 }])).toEqual([]);
    expect(problems([{ name: 'a', cc: 20, min: 3, max: 3 }])).toEqual(['a: min and max are both 3, so the knob has nowhere to turn']);
    expect(problems([{ name: 'a', cc: 20, min: 0, max: 1, default: 2 }])).toEqual(['a: default 2 is outside its range, 0 to 1']);
  });

  it('rejects a field it does not know', () => {
    expect(problems([{ name: 'a', cc: 20, warp: 'exp' }])).toHaveLength(1);
  });
});
