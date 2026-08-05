import { eqRule, limitRule, reverbRule } from './effects.js';
import { mixRule } from './mix.js';
import { normalizeRule } from './normalize.js';
import { scRenderRule } from './sc-render.js';
import { trackRenderRule } from './track-render.js';
import type { RuleImpl, RuleSpec } from './types.js';

// Each impl is typed against its own spec (RuleImpl<NormalizeTarget>, …),
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
  'sc-render': scRenderRule,
  'track-render': trackRenderRule,
};

export function ruleImpl<T extends RuleSpec>(spec: T): RuleImpl<T> {
  return RULES[spec.rule] as unknown as RuleImpl<T>;
}

export type { ExtraInput, RuleImpl, RuleSpec, RunContext, ValidateContext } from './types.js';
