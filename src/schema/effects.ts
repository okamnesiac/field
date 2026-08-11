import { z } from 'zod';
import type { KeyOrder } from '../yaml/emit.js';

// Effect parameters for `inserts:` entries (effects.md §5) — on any
// track, the song's master chain included, since that is the output
// track's inserts.

// eq: RBJ biquads with Fyra's parameterization — bandwidth in octaves —
// and Fyra's response-based auto-gain on by default (effects.md §2):
// EQ moves change tone, not level.
export const eqBandSchema = z.strictObject({
  type: z.enum(['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass']),
  frequency: z.number().min(10).max(24000),
  gain_db: z.number().min(-24).max(24).default(0), // bell and shelves only
  bandwidth: z.number().min(0.1).max(16).default(2), // octaves
});
export type EqBand = z.infer<typeof eqBandSchema>;

export const eqParams = {
  bands: z.array(eqBandSchema).min(1).max(8),
  normalize: z.boolean().default(true),
};

// limit: offline lookahead peak limiter (effects.md §2).
export const limitParams = {
  ceiling_db: z.number().min(-24).max(0).default(-1),
  lookahead_ms: z.number().min(0.1).max(50).default(5),
  release_ms: z.number().min(1).max(2000).default(100),
};

// reverb: Freeverb, deterministic; decay is T60 in seconds and the output
// grows by the tail (effects.md §2).
export const reverbParams = {
  mix: z.number().min(0).max(1).default(0.3),
  decay: z.number().min(0.05).max(30).default(2), // seconds to −60 dB
  predelay_ms: z.number().min(0).max(500).default(0),
  damping: z.number().min(0).max(1).default(0.5),
};

// plate: Dattorro's 1997 figure-8 tank (reverbs.md decision 2); decay
// is T60 in seconds and the output grows by the tail, like reverb's.
export const plateParams = {
  mix: z.number().min(0).max(1).default(0.3),
  // Floored at 1: the tank's fixed diffusion allpasses ring for
  // ~0.9 s at the published coefficients, so a shorter T60 would
  // out-ring the analytic tail the compiler counts on.
  decay: z.number().min(1).max(30).default(2), // seconds to −60 dB
  predelay_ms: z.number().min(0).max(500).default(0),
  damping: z.number().min(0).max(1).default(0.5),
  // Input diffusion 1 directly (#2 rides at 5/6 of it); the default is
  // the paper's published pair. The cap keeps the input allpasses'
  // own ring inside the minimum decay: at 0.93 the 142-sample lattice
  // reaches −60 dB in ~0.45 s and the measured tail slope at the
  // worst corner (decay 1, diffusion 0.93) stays inside the T60
  // property window, where 0.98 rang ~1.6 s and out-lived the
  // declared tail (Codex's finding on #144 — and the paper agrees:
  // optimum diffusion "lies closer to |0.5| than to the extreme
  // values").
  diffusion: z.number().min(0).max(0.93).default(0.75),
  modulation: z.number().min(0).max(1).default(0.3), // tail motion; 0 = frozen
};

// hall: a Jot FDN with per-band decay (reverbs.md decision 3); decay
// is the mid-band T60 and the low/high bands are multipliers on it —
// rooms keep their lows and lose their highs, said directly. The
// output grows by the longest band's tail.
export const hallParams = {
  mix: z.number().min(0).max(1).default(0.3),
  // Floored at 1 like the plate's, and for the same reason: the input
  // diffusers' own ring must stay inside the declared tail.
  decay: z.number().min(1).max(30).default(2), // mid-band T60, seconds
  decay_low: z.number().min(0.1).max(4).default(1), // × decay below ~300 Hz
  decay_high: z.number().min(0.1).max(4).default(0.5), // × decay above ~4 kHz
  size: z.number().min(0.1).max(1).default(1), // delay-line scale: small room → hall
  predelay_ms: z.number().min(0).max(500).default(0),
  // Same mapping and cap as the plate's diffusion, and the hall's
  // diffuser lines are chosen short enough (≤ 401 at 48 kHz) that the
  // same corner arithmetic holds.
  diffusion: z.number().min(0).max(0.93).default(0.8),
  modulation: z.number().min(0).max(1).default(0.3), // line motion; 0 = frozen
  width: z.number().min(0).max(1).default(1), // stereo taps blended mid/side
};

// Built-in insert entries — discriminated on `effect:`, the obligation
// recorded in effects.md §1.
export const effectInsertSchema = z.discriminatedUnion('effect', [
  z.strictObject({ effect: z.literal('eq'), ...eqParams }),
  z.strictObject({ effect: z.literal('limit'), ...limitParams }),
  z.strictObject({ effect: z.literal('reverb'), ...reverbParams }),
  z.strictObject({ effect: z.literal('plate'), ...plateParams }),
  z.strictObject({ effect: z.literal('hall'), ...hallParams }),
]);
export type EffectInsert = z.infer<typeof effectInsertSchema>;

// A hosted plugin insert (plugin-hosting.md §3) — discriminated by
// `plugin:` the way input entries are discriminated by field name. The
// display name is cosmetic and never keyed; the exact identity lives in
// a field named by its format, written back by the tool (`field check`
// pins an unpinned entry when a scan knows the plugin), alongside
// `version:` and a nonzero `latency:`. `state:` is a short content hash
// resolving into shared/plugins/ by filename; `params:` is the plugin's
// own parameter names in its own natural units, spelled `Name#<id>`
// only where a plugin exposes duplicate display names.
export const pluginInsertSchema = z
  .strictObject({
    plugin: z.string().min(1),
    id: z.string().min(1).optional(), // required by check when one chain repeats a plugin
    au: z
      .string()
      .regex(/^.{4}\/.{4}\/.{4}$/, 'an AU identity is type/subtype/manufacturer, three 4CCs')
      .optional(),
    // What is pinned is JUCE's 32-bit plugin uid, not the VST3 class
    // TUID — JUCE does not surface the TUID, and this derivation is
    // JUCE's to change (it moved once already: `deprecatedUid`), which
    // is decision 9's installer exposure one layer down; the plan
    // records it beside that decision so the refusal is predictable.
    vst3: z
      .string()
      .regex(/^[0-9a-f]{1,8}$/, "a VST3 identity is JUCE's 32-bit plugin uid in lowercase hex")
      .optional(),
    version: z.string().min(1).optional(),
    latency: z.number().int().min(0).optional(), // samples; tool-written, omitted when zero
    tail: z.number().positive().max(120).optional(), // seconds; declared override, else ring-out
    state: z
      .string()
      .regex(/^[0-9a-f]{8,64}$/, 'a state ref is 8–64 lowercase hex chars of the blob hash')
      .optional(),
    // Numbers in the plugin's natural units; strings for labeled
    // parameters ("4:1") — the plugin's own display spelling.
    params: z.record(z.string(), z.union([z.number(), z.string().min(1)])).optional(),
  })
  .refine((entry) => entry.au === undefined || entry.vst3 === undefined, {
    message: 'a plugin is pinned as `au:` or `vst3:`, never both',
  });
export type PluginInsert = z.infer<typeof pluginInsertSchema>;

// One entry, two shapes, dispatched by the presence of `plugin:` rather
// than parsed as a plain union — z.union reports whichever arm's error
// it likes, which for the two commonest authoring mistakes (a misspelled
// key, a misspelled effect) is neither; dispatching first keeps every
// arm's own diagnostics (minjudd measured the loss on #148).
export const insertSchema = z.unknown().transform((value, ctx): EffectInsert | PluginInsert => {
  const isPlugin = typeof value === 'object' && value !== null && 'plugin' in value;
  const result = isPlugin ? pluginInsertSchema.safeParse(value) : effectInsertSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue(issue as Parameters<typeof ctx.addIssue>[0]);
    }
    return z.NEVER;
  }
  return result.data;
});
export type Insert = z.infer<typeof insertSchema>;

export function isHostedInsert(insert: Insert): insert is PluginInsert {
  return 'plugin' in insert;
}

export const insertOrder: KeyOrder = {
  keys: [
    'effect',
    'plugin',
    'id',
    'au',
    'vst3',
    'version',
    'latency',
    'tail',
    'state',
    'params',
    'bands',
    'normalize',
    'ceiling_db',
    'lookahead_ms',
    'release_ms',
    'mix',
    'decay',
    'decay_low',
    'decay_high',
    'size',
    'predelay_ms',
    'damping',
    'diffusion',
    'modulation',
    'width',
  ],
  children: { bands: { items: { keys: ['type', 'frequency', 'gain_db', 'bandwidth'] } } },
};
