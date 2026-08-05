import type { Target } from '../schema/schemas.js';
import { normalizeRule } from './normalize.js';
import { scRenderRule } from './sc-render.js';
import type { RuleImpl } from './types.js';

const RULES: Record<Target['rule'], RuleImpl> = {
  normalize: normalizeRule,
  'sc-render': scRenderRule,
};

export function getRule(name: Target['rule']): RuleImpl {
  return RULES[name];
}

export type { ExtraInput, RuleImpl, RunContext, ValidateContext } from './types.js';
