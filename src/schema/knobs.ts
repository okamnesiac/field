import { z } from 'zod';

// A knob file (instrument-knobs.md §2.2): an instrument's knobs, each a
// MIDI controller that `field keys` turns and shows through a range. This
// schema is the one check of a knob file; every path that hands one to an
// instrument runs it first.

// Why each controller a knob cannot use is taken.
const TAKEN: ReadonlyMap<number, string> = new Map([
  [0, 'bank select'],
  [1, 'the modulation wheel, which is the knob mod'],
  [6, 'data entry'],
  [32, 'bank select'],
  [38, 'data entry'],
  [64, 'the sustain pedal'],
  [96, 'data increment'],
  [97, 'data decrement'],
  [98, 'a parameter-number controller'],
  [99, 'a parameter-number controller'],
  [100, 'a parameter-number controller'],
  [101, 'a parameter-number controller'],
]);

// 120 to 127 are channel mode messages.
const LAST_KNOB_CC = 119;

const knob = z
  .object({
    name: z.string().min(1),
    cc: z.number().int(),
    min: z.number().default(0),
    max: z.number().default(127),
    curve: z.enum(['lin', 'exp']).default('lin'),
    step: z.number().min(0).default(0),
    units: z.string().min(1).optional(),
    default: z.number().optional(),
  })
  .strict()
  .transform(({ default: start, ...rest }) => ({ ...rest, default: start ?? rest.min }));

export type Knob = z.infer<typeof knob>;

export const knobFileSchema = z
  .object({ knobs: z.array(knob) })
  .strict()
  .superRefine(({ knobs }, ctx) => {
    const names = new Set<string>();
    const ccs = new Set<number>();
    knobs.forEach((k, i) => {
      const problem = (field: string, message: string): void => {
        ctx.addIssue({ code: 'custom', path: ['knobs', i, field], message: `${k.name}: ${message}` });
      };
      if (k.name === 'mod') problem('name', 'mod is the modulation wheel, the knob field keys always shows first');
      else if (names.has(k.name)) problem('name', 'appears twice; a name names one knob');
      names.add(k.name);

      const taken = TAKEN.get(k.cc);
      if (k.cc < 0 || k.cc > 127) problem('cc', `cc ${k.cc} is not a MIDI controller, which runs from 0 to 127`);
      else if (k.cc > LAST_KNOB_CC) problem('cc', `cc ${k.cc} is a channel mode message`);
      else if (taken !== undefined) problem('cc', `cc ${k.cc} is ${taken}`);
      else if (ccs.has(k.cc)) problem('cc', `cc ${k.cc} turns another knob in this file`);
      ccs.add(k.cc);

      if (k.min === k.max) problem('max', `min and max are both ${k.min}, so the knob has nowhere to turn`);
      else if (k.curve === 'exp' && (k.min === 0 || k.max === 0 || Math.sign(k.min) !== Math.sign(k.max))) {
        problem('min', `an exp curve needs min and max of one sign and neither 0, not ${k.min} and ${k.max}`);
      } else if (k.default < Math.min(k.min, k.max) || k.default > Math.max(k.min, k.max)) {
        problem('default', `default ${k.default} is outside its range, ${k.min} to ${k.max}`);
      }
    });
  });
