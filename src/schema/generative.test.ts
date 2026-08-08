import { describe, expect, it } from 'vitest';
import { generativeSoundSchema } from './sounds.js';

// The kind split inside `generative` (voice-generation.md §1.6). One
// schema serves music and voice recipes so that variants, `chosen`, the
// hashes and `field choose` stay single-implementation; what keeps that
// from becoming a shape nobody can reason about is that every recipe is
// exactly one kind, enforced here rather than described in a comment.
//
// Worth recording because §1.6's parenthetical is now wrong while its
// conclusion survives: it justified a refine by saying the recipe schema
// is "a single object, not a discriminated union", and after the layout
// migration it is a member of one. zod v4 accepts a refined member and
// still narrows on the discriminant, so the decision holds — but for a
// different reason than the one written down.

const base = {
  name: 'scratch-vocal',
  type: 'generative' as const,
  model: 'chatterbox',
  seed: 1,
  variants: [
    {
      file: 'audio/scratch-vocal/1.wav',
      seed: 1,
      sha256: 'a'.repeat(64),
    },
  ],
  generated_at: '2026-08-07T12:00:00Z',
};

const music = { ...base, prompt: 'dreamy keys', duration_seconds: 10 };
const voice = {
  ...base,
  text: 'I walked the fence line in the tall grass',
  voice_ref: 'justin-ref',
  voice_ref_sha256: 'b'.repeat(64),
};

describe('generative recipes', () => {
  it('accepts a music recipe and a voice recipe', () => {
    expect(generativeSoundSchema.safeParse(music).success).toBe(true);
    expect(generativeSoundSchema.safeParse(voice).success).toBe(true);
  });

  it('refuses a recipe that is both kinds or neither', () => {
    // The chimera and the blank. A generator handed either would have to
    // guess which model to run, which is the guess this exists to remove.
    const both = generativeSoundSchema.safeParse({ ...music, text: 'hello' });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toMatch(/either .prompt. \(music\) or .text. \(voice\)/);

    const neither = generativeSoundSchema.safeParse(base);
    expect(neither.success).toBe(false);
    expect(neither.error?.issues[0]?.message).toMatch(/needs .prompt. \(music\) or .text. \(voice\)/);
  });

  it('keeps music-only fields off voice recipes', () => {
    // A voice line's length follows from its text, so `duration_seconds`
    // on one is a number nothing would honour — and a recipe carrying a
    // field its generator ignores is a recipe that lies about its inputs.
    for (const field of ['lyrics', 'bpm', 'bars', 'duration_seconds'] as const) {
      const value = field === 'lyrics' ? 'la la' : field === 'bpm' ? 120 : 4;
      const parsed = generativeSoundSchema.safeParse({ ...voice, [field]: value });
      expect(parsed.success, `${field} on a voice recipe`).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/music-only/);
    }
  });

  it('keeps voice-only fields off music recipes', () => {
    for (const field of [
      'voice_ref',
      'voice_ref_sha256',
      'exaggeration',
      'conviction',
    ] as const) {
      const value =
        field === 'voice_ref'
          ? 'justin-ref'
          : field === 'voice_ref_sha256'
            ? 'c'.repeat(64)
            : 0.3;
      const parsed = generativeSoundSchema.safeParse({ ...music, [field]: value });
      expect(parsed.success, `${field} on a music recipe`).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/voice-only/);
    }
  });

  it('accepts a voice recipe with no reference at all — the default voice', () => {
    // `voice_ref` is optional, not merely paired: a recipe with `text`
    // alone means the model's own default voice, which is what bloom
    // uses until a reference recording exists. The voice is then defined
    // by `model:` and nothing else, and that is honest rather than
    // lossy — inference is not reproducible anyway, which is why §1.1
    // commits the output instead of regenerating it.
    //
    // Pinned because a later tightening that made `voice_ref` required
    // would look like a correctness fix and would break the only
    // configuration currently in use.
    const { voice_ref, voice_ref_sha256, ...noReference } = voice;
    void voice_ref;
    void voice_ref_sha256;
    expect(generativeSoundSchema.safeParse(noReference).success).toBe(true);
  });

  it('requires the reference recording and its hash together', () => {
    // The recording *is* the voice (§1.3), so the recipe pins its bytes
    // the way it pins a variant's. A name without a hash would let the
    // file change under a recipe still claiming to describe it — the
    // provenance argument for preferring a recording to a vendor ID
    // collapses if the recording is not pinned.
    const nameOnly = generativeSoundSchema.safeParse({ ...voice, voice_ref_sha256: undefined });
    expect(nameOnly.success).toBe(false);
    expect(nameOnly.error?.issues[0]?.message).toMatch(/go together/);

    const hashOnly = generativeSoundSchema.safeParse({ ...voice, voice_ref: undefined });
    expect(hashOnly.success).toBe(false);
  });

  it('still rejects unknown keys', () => {
    // The refine sits on a strict object; adding one must not have
    // loosened the other.
    expect(generativeSoundSchema.safeParse({ ...voice, tempo: 120 }).success).toBe(false);
  });
});

describe('the voice delivery knobs', () => {
  // Bounds narrower than Chatterbox's, on purpose: widening a range
  // later leaves every committed recipe valid, narrowing one does not
  // (voice-generation.md §8).
  it('accepts a voice recipe carrying either or both', () => {
    expect(generativeSoundSchema.safeParse({ ...voice, exaggeration: 0.3 }).success).toBe(true);
    expect(generativeSoundSchema.safeParse({ ...voice, conviction: 0.3 }).success).toBe(true);
    const both = generativeSoundSchema.safeParse({
      ...voice,
      exaggeration: 2,
      conviction: 1,
    });
    expect(both.success).toBe(true);
  });

  it('refuses values outside the range rather than clamping them', () => {
    // A clamped value would be recorded as the number asked for while
    // the audio came from a different one.
    for (const bad of [{ exaggeration: 0.2 }, { exaggeration: 2.1 }]) {
      expect(generativeSoundSchema.safeParse({ ...voice, ...bad }).success).toBe(false);
    }
    for (const bad of [{ conviction: 0.05 }, { conviction: 1.1 }]) {
      expect(generativeSoundSchema.safeParse({ ...voice, ...bad }).success).toBe(false);
    }
  });
});
