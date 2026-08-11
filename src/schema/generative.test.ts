import { describe, expect, it } from 'vitest';
import { generativeEntrySchema, generativeTakesSchema } from './generative.js';

// The kind split inside `generative` (voice-generation.md §1.6). One
// schema serves music and voice requests so that variants, `chosen`, the
// hashes and `field choose` stay single-implementation; what keeps that
// from becoming a shape nobody can reason about is that every request is
// exactly one kind, enforced here rather than described in a comment.
// These asserted against the generative *sound* schema until `sounds/`
// retired (nested-tracks.md §18, decision 12); the entry carries the
// same fields and the same refinement, which is exactly what the fold
// promised.

// A request is the request and nothing else: takes live beside their
// audio (bloom-in-tree.md §7), so the two fixtures are separate files in
// the same way the real ones are.
const takeOne = {
  file: 'audio/scratch-vocal/1.wav',
  model: 'chatterbox',
  seed: 1,
  sha256: 'a'.repeat(64),
  generated_at: '2026-08-07T12:00:00Z',
};
const takes = { gen: 'scratch-vocal', chosen: 1, variants: [takeOne] };

const music = { prompt: 'dreamy keys', duration_seconds: 10 };
const voice = {
  text: 'I walked the fence line in the tall grass',
  voice_ref: 'justin-ref',
  voice_ref_sha256: 'b'.repeat(64),
};

describe('generative requests', () => {
  it('accepts a music request and a voice request', () => {
    expect(generativeEntrySchema.safeParse(music).success).toBe(true);
    expect(generativeEntrySchema.safeParse(voice).success).toBe(true);
  });

  it('accepts a takes file with no takes, however the absence is spelled', () => {
    // The shape a project ships in when its audio is not committed
    // (bloom-in-tree.md §3). Both spellings have to work — a hand-written
    // file omits the key — and they were separate failures before this
    // defaulted.
    const { variants: _omit, ...noKey } = takes;
    const absent = generativeTakesSchema.safeParse(noKey);
    const empty = generativeTakesSchema.safeParse({ ...takes, variants: [] });
    expect(absent.success).toBe(true);
    expect(empty.success).toBe(true);
    expect(absent.data?.variants).toEqual([]);
  });

  it('makes a music request say how long, since filling cannot be told later', () => {
    // Left to `generate`, the failure names --bars/--duration, and those
    // are refused on a request that already says what to generate — so
    // the advice would be for a door that is locked. `check` says it
    // instead.
    const { duration_seconds: _seconds, ...noLength } = music;
    const parsed = generativeEntrySchema.safeParse(noLength);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toContain('a music recipe needs a length');
    expect(generativeEntrySchema.safeParse({ ...noLength, bars: 4 }).success).toBe(true);
    // A voice line is not asked: its length follows from the text.
    expect(generativeEntrySchema.safeParse(voice).success).toBe(true);
  });

  it('keeps provenance on the take, so takes may differ', () => {
    // A request accumulates runs, and two takes a month apart can come
    // from different model versions with different generation times. One
    // `model`/`generated_at` pair on the request could record only one
    // answer for the whole list; on the variant it records each.
    const mixed = generativeTakesSchema.safeParse({
      ...takes,
      variants: [
        takeOne,
        {
          file: 'audio/scratch-vocal/2.wav',
          model: 'chatterbox-2',
          seed: 2,
          sha256: 'c'.repeat(64),
          generated_at: '2026-09-07T12:00:00Z',
        },
      ],
    });
    expect(mixed.success).toBe(true);
    expect(mixed.data?.variants.map((v) => v.model)).toEqual(['chatterbox', 'chatterbox-2']);
  });

  it('refuses a request that is both kinds or neither', () => {
    // The chimera and the blank. A generator handed either would have to
    // guess which model to run, which is the guess this exists to remove.
    const both = generativeEntrySchema.safeParse({ ...music, text: 'hello' });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toMatch(/either .prompt. \(music\) or .text. \(voice\)/);

    const neither = generativeEntrySchema.safeParse({});
    expect(neither.success).toBe(false);
    expect(neither.error?.issues[0]?.message).toMatch(/needs .prompt. \(music\) or .text. \(voice\)/);
  });

  it('keeps music-only fields off voice requests', () => {
    // A voice line's length follows from its text, so `duration_seconds`
    // on one is a number nothing would honour — and a request carrying a
    // field its generator ignores is a request that lies about its inputs.
    for (const field of ['lyrics', 'bpm', 'bars', 'duration_seconds'] as const) {
      const value = field === 'lyrics' ? 'la la' : field === 'bpm' ? 120 : 4;
      const parsed = generativeEntrySchema.safeParse({ ...voice, [field]: value });
      expect(parsed.success, `${field} on a voice request`).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/music-only/);
    }
  });

  it('keeps voice-only fields off music requests', () => {
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
      const parsed = generativeEntrySchema.safeParse({ ...music, [field]: value });
      expect(parsed.success, `${field} on a music request`).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/voice-only/);
    }
  });

  it('accepts a voice request with no reference at all — the default voice', () => {
    // `voice_ref` is optional, not merely paired: a request with `text`
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
    expect(generativeEntrySchema.safeParse(noReference).success).toBe(true);
  });

  it('requires the reference recording and its hash together', () => {
    // The recording *is* the voice (§1.3), so the request pins its bytes
    // the way it pins a variant's. A name without a hash would let the
    // file change under a request still claiming to describe it — the
    // provenance argument for preferring a recording to a vendor ID
    // collapses if the recording is not pinned.
    const nameOnly = generativeEntrySchema.safeParse({ ...voice, voice_ref_sha256: undefined });
    expect(nameOnly.success).toBe(false);
    expect(nameOnly.error?.issues[0]?.message).toMatch(/go together/);

    const hashOnly = generativeEntrySchema.safeParse({ ...voice, voice_ref: undefined });
    expect(hashOnly.success).toBe(false);
  });

  it('still rejects unknown keys', () => {
    // The refine sits on a strict object; adding one must not have
    // loosened the other.
    expect(generativeEntrySchema.safeParse({ ...voice, tempo: 120 }).success).toBe(false);
  });
});

describe('the voice delivery knobs', () => {
  // Bounds narrower than Chatterbox's, on purpose: widening a range
  // later leaves every committed request valid, narrowing one does not
  // (voice-generation.md §8).
  it('accepts a voice request carrying either or both', () => {
    expect(generativeEntrySchema.safeParse({ ...voice, exaggeration: 0.3 }).success).toBe(true);
    expect(generativeEntrySchema.safeParse({ ...voice, conviction: 0.3 }).success).toBe(true);
    const both = generativeEntrySchema.safeParse({
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
      expect(generativeEntrySchema.safeParse({ ...voice, ...bad }).success).toBe(false);
    }
    for (const bad of [{ conviction: 0.05 }, { conviction: 1.1 }]) {
      expect(generativeEntrySchema.safeParse({ ...voice, ...bad }).success).toBe(false);
    }
  });
});
