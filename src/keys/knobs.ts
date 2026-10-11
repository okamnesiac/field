import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { knobFileSchema, type Knob } from '../schema/knobs.js';
import { watchText } from './watch.js';

// Knob files (instrument-knobs.md §2.2): finding them, reading and
// watching them, and what a controller value means on each knob.

const SUFFIX = '.knobs.yaml';
export const CC_MAX = 127;

// The modulation wheel, the knob every instrument has, which `field keys`
// shows first (§2.1).
export const MOD_KNOB: Knob = { name: 'mod', cc: 1, min: 0, max: CC_MAX, curve: 'lin', step: 1, default: 0 };

// A knob as the line names it: after its source's name when knobs come
// from more than one place, as in keys.cutoff (§2.5).
export interface ShownKnob {
  label: string;
  knob: Knob;
}

// `mod`, then each source's knobs in its file's order.
export function knobList(sources: { name: string; knobs: Knob[] }[]): ShownKnob[] {
  const named = sources.length > 1;
  return [
    { label: MOD_KNOB.name, knob: MOD_KNOB },
    ...sources.flatMap(({ name, knobs }) => knobs.map((knob) => ({ label: named ? `${name}.${knob.name}` : knob.name, knob }))),
  ];
}

// An instrument's knob file sits beside its program: juno.knobs.yaml for
// juno.scd.
export function knobFileFor(program: string): string {
  return `${program.endsWith('.scd') ? program.slice(0, -'.scd'.length) : program}${SUFFIX}`;
}

// A bare name is a knob file on the project's instruments shelf, and
// anything with a / or ending in .yaml is a path, as a keymap resolves.
export function resolveKnobsPath(
  spec: string,
  root: string | undefined,
  options: { home?: string; cwd?: string } = {},
): string {
  if (spec.includes('/') || spec.endsWith('.yaml')) {
    const expanded = spec.startsWith('~/') ? join(options.home ?? homedir(), spec.slice(2)) : spec;
    return resolve(options.cwd ?? process.cwd(), expanded);
  }
  if (root === undefined) {
    throw new Error(
      `--knobs ${spec}: a bare name names a knob file in a project's shared/instruments/, ` +
        'and this is not inside a Field project; give a path instead, such as ./knobs.yaml',
    );
  }
  return join(root, 'shared', 'instruments', `${spec}${SUFFIX}`);
}

// What a knob file's knobs are called on the line when knobs come from
// more than one place: ju-06a for ju-06a.knobs.yaml or ju-06a.yaml.
export function knobFileName(path: string): string {
  const name = basename(path);
  return name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : basename(name, '.yaml');
}

export class KnobsError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

export function parseKnobs(text: string, path: string): Knob[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new KnobsError(path, doc.errors.map((e) => e.message.split('\n')[0]!));
  const parsed = knobFileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new KnobsError(
      path,
      parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
    );
  }
  return parsed.data.knobs;
}

export function loadKnobs(path: string): Knob[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new KnobsError(path, [(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message]);
  }
  return parseKnobs(text, path);
}

export type KnobsReload = { knobs: Knob[] } | { error: KnobsError };

export function watchKnobs(path: string, onReload: (result: KnobsReload) => void, settleMs = 50): () => void {
  return watchText(
    path,
    (text) => {
      try {
        onReload({ knobs: parseKnobs(text, path) });
      } catch (err) {
        onReload({ error: err instanceof KnobsError ? err : new KnobsError(path, [(err as Error).message]) });
      }
    },
    settleMs,
  );
}

// The copy of a checked knob file that a SuperCollider voice reads
// through FIELD_KNOBS (§2.4): every field spelled out, defaults filled,
// so the voice never has to know the schema's defaults.
export function knobsCopy(knobs: Knob[]): string {
  return stringify({ knobs });
}

// A controller value from 0 to 127 as the knob's value: SuperCollider's
// ControlSpec.map for the warp of the same name, so a voice that maps
// with ControlSpec agrees with the line.
export function knobValue(knob: Knob, cc: number): number {
  const x = cc / CC_MAX;
  const value = knob.curve === 'exp' ? knob.min * (knob.max / knob.min) ** x : knob.min + (knob.max - knob.min) * x;
  return knob.step > 0 ? Math.round(value / knob.step) * knob.step : value;
}

// The controller value a knob's value sits at, rounded: where a knob
// that has not been turned starts from.
export function controllerOf(knob: Knob, value: number): number {
  const x =
    knob.curve === 'exp' ? Math.log(value / knob.min) / Math.log(knob.max / knob.min) : (value - knob.min) / (knob.max - knob.min);
  return Math.min(CC_MAX, Math.max(0, Math.round(x * CC_MAX)));
}

// One step up or down from controller value `cc`: the next value, or on a
// knob with a step, the next that maps to a different value, so a knob
// with two positions moves in one press. Stays at `cc` at either end.
export function stepFrom(knob: Knob, cc: number, direction: 1 | -1): number {
  const position = (v: number): number => (knob.step > 0 ? Math.round(knobValue(knob, v) / knob.step) : v);
  const from = position(cc);
  for (let v = cc + direction; v >= 0 && v <= CC_MAX; v += direction) {
    if (position(v) !== from) return v;
  }
  return cc;
}

// A knob's value as the line prints it (§2.5), without its padding.
export function formatKnobValue(knob: Knob, value: number): string {
  if (Number.isInteger(knob.step) && knob.step >= 1) return withUnits(String(Math.round(value)), knob.units);
  if (knob.curve === 'lin') {
    const farthest = Math.max(Math.abs(knob.min), Math.abs(knob.max));
    return withUnits(fixed(value, Math.max(0, 2 - Math.floor(Math.log10(farthest)))), knob.units);
  }
  const shown = Math.abs(Number(significant(value)));
  if (shown >= 1000) return withUnits(significant(value / 1000), knob.units, 'k');
  if (knob.units === 's' && shown < 1) return withUnits(significant(value * 1000), knob.units, 'm');
  return withUnits(significant(value), knob.units);
}

// The widest the knob's value prints, at its default or at any controller
// value, so turning it never moves what follows it.
export function knobValueWidth(knob: Knob): number {
  let width = formatKnobValue(knob, knob.default).length;
  for (let cc = 0; cc <= CC_MAX; cc++) width = Math.max(width, formatKnobValue(knob, knobValue(knob, cc)).length);
  return width;
}

// A prefix with no units to carry it goes on the number itself: 2.00k.
function withUnits(number: string, units: string | undefined, prefix = ''): string {
  return units === undefined ? `${number}${prefix}` : `${number} ${prefix}${units}`;
}

// Three significant digits, counted on the rounded value, so 0.9999
// prints 1.00 rather than 1.000.
function significant(x: number): string {
  if (x === 0) return fixed(0, 2);
  const places = (y: number): number => Math.max(0, 2 - Math.floor(Math.log10(Math.abs(y))));
  return fixed(x, places(Number(x.toFixed(places(x)))));
}

// toFixed, without the sign it leaves on a value that rounds to zero.
function fixed(x: number, places: number): string {
  const text = x.toFixed(places);
  return Number(text) === 0 ? text.replace('-', '') : text;
}
