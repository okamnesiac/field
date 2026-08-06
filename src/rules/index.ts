import { eqRule, limitRule, reverbRule } from './effects.js';
import { mixRule } from './mix.js';
import { normalizeRule } from './normalize.js';
import { sayRule } from './say.js';
import { supercolliderRule } from './supercollider.js';
import { trackRenderRule } from './track-render.js';
import type { RuleImpl, RuleSpec } from './types.js';

// The translation point between the format's vocabulary and the
// engine's (project-layout.md §4): a sound's `type:` keys into the rule
// implementation that realizes it. `generate` is deliberately absent —
// a deliberate sound has no rule, which is the §1.2 trigger policy.
// Each impl is typed against its own spec (RuleImpl<NormalizeSound>, …),
// which is what makes the per-method "wrong rule" guards unnecessary — the
// compiler proves them inside each module. The one seam TypeScript cannot
// prove is this lookup: connecting a union's discriminant to a heterogeneous
// record needs a cast, so the cast lives here and only here. It is sound
// because RULES maps every discriminant to the impl typed for exactly that
// spec.
const RULES = {
  eq: eqRule,
  limit: limitRule,
  mix: mixRule,
  normalize: normalizeRule,
  reverb: reverbRule,
  say: sayRule,
  supercollider: supercolliderRule,
  'track-render': trackRenderRule,
};

export function ruleImpl<T extends RuleSpec>(spec: T): RuleImpl<T> {
  return RULES[spec.type] as unknown as RuleImpl<T>;
}

export type {
  ExtraInput,
  RuleImpl,
  RuleSpec,
  RunContext,
  SourceNames,
  ValidateContext,
} from './types.js';
