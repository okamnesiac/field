// field-voiced's own half of the protocol: what a voice job is. The
// shared shapes — hello, ok/error, the generate response, progress
// events — are src/workers/protocol.ts, mirrored in Python by
// field_worker.protocol.

// No duration: a line's length follows from its text, which is why the
// recipe schema refuses `duration_seconds` on a voice recipe
// (voice-generation.md §1.6). `voice_ref` is a resolved *path*, not an
// asset name — the worker never learns what an asset is — and omitting
// it means the model's own voice, which is a first-class case (§6).
export interface VoiceGenerateJob {
  text: string;
  seed: number;
  variants: number;
  output_dir: string;
  // Omitted, or a real path. The worker refuses an empty string rather
  // than reading it as "no reference": those are different requests and
  // only one of them is what the caller meant (#60 review).
  voice_ref?: string | undefined;
  // Chatterbox's expressive knobs. `conviction` is its `cfg_weight`
  // under a name a musician can read (voice-generation.md §8); the
  // adapter does the translation, which is what an adapter is for.
  // Omitted means the model's own defaults, not a value we chose.
  exaggeration?: number | undefined;
  conviction?: number | undefined;
}
