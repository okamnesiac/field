import { eqGenerator, limitGenerator, reverbGenerator } from './effects.js';
import { resampleGenerator } from './resample.js';
import { supercolliderGenerator } from './supercollider.js';
import { stemGenerator } from './stem.js';
import type { Generator, GeneratorSpec } from './types.js';

// The translation point between the format's vocabulary and the
// engine's (project-layout.md §4): a sound's `type:` keys into the rule
// implementation that realizes it. `generate` is deliberately absent —
// a deliberate sound has no rule, which is the §1.2 trigger policy.
// Each impl is typed against its own spec (Generator<NormalizeSound>, …),
// which is what makes the per-method "wrong rule" guards unnecessary — the
// compiler proves them inside each module. The one seam TypeScript cannot
// prove is this lookup: connecting a union's discriminant to a heterogeneous
// record needs a cast, so the cast lives here and only here. It is sound
// because RULES maps every discriminant to the impl typed for exactly that
// spec.
const RULES = {
  eq: eqGenerator,
  limit: limitGenerator,
  resample: resampleGenerator,
  reverb: reverbGenerator,
  supercollider: supercolliderGenerator,
  stem: stemGenerator,
};

export function generatorFor<T extends GeneratorSpec>(spec: T): Generator<T> {
  return RULES[spec.type] as unknown as Generator<T>;
}

export type {
  ExtraInput,
  Generator,
  GeneratorSpec,
  RunContext,
  SourceNames,
  ValidateContext,
} from './types.js';
