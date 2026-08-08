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
    for (const field of ['voice_ref', 'voice_ref_sha256'] as const) {
      const value = field === 'voice_ref' ? 'justin-ref' : 'c'.repeat(64);
      const parsed = generativeSoundSchema.safeParse({ ...music, [field]: value });
      expect(parsed.success, `${field} on a music recipe`).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/voice-only/);
    }
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
