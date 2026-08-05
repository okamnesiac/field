# Plan: Offline mix assembly

**Status:** In progress (started 2026-08-05). Follows
[sc-render.md](sc-render.md) — the phase order was re-decided after #8: mix
assembly, then playback, then ACE, because a listenable arrangement makes
every later phase testable by ear. The first listenable `//mix` target.

**Goal:** `bloom build //songs/<song>/mix:main` renders an actual arrangement:
clips placed on the timeline (position, source offset, slip), summed with
gain, pan, and fades, out to a mix asset.

## 1 Shape

- Offline mixing has no real-time deadline, so **the first mixer is
  TypeScript** — sample-accurate summing over Float32Arrays is fine off-line,
  and it avoids standing up the native toolchain a phase early. The daemon
  subsumes this DSP later; the build rule's contract (inputs, params, output)
  doesn't change when the executor does. This is a deliberate exception to
  "C++ for everything with a deadline": there is no deadline here.
- Scope of DSP: gain, pan, crossfades/fades, clip windowing, tempo-map-aware
  placement, summing to stereo. No plugins (that phase comes with the daemon
  and AU hosting).
- This phase is what forces the timeline/tempo and clip schemas
  ([project-core.md](project-core.md) §3) to be real: rendering is the test.

## 2 Definition of done

Generated SC and ACE material arranged into a song section and built into a
listenable stereo mix; moving a clip, slipping it, or changing a fade is a
one-line YAML diff followed by an incremental rebuild that only re-renders
what changed.

## 3 Graph shape (DECIDED)

Two rules, and the incrementality falls out of where the cut is:

- **`track-render`** — an *implicit* target per audio track that has clips:
  `//songs/<song>/tracks:<name>`, derived from the track file the same way
  asset targets derive from `assets.yaml`. It places the track's clips
  through the tempo map and renders one Float32 stereo stem starting at
  timeline sample 0 (leading silence included), length = the track's own
  last clip end. Stems deliberately do **not** depend on other tracks — no
  shared "song length" input — so editing one track never rebuilds another's
  stem.
- **`mix`** — declared in `songs/<song>/mix.yaml` (collection file → package
  `//songs/<song>/mix`), normally one target named `main`. Its inputs are
  track stems: the first rule→rule edges in the graph. It aligns stems at
  sample 0 and sums.

Track `gain_db`/`pan` are **mix parameters, not stem contents**: stems are
rendered pre-fader, and the mix rule applies track gain and pan while
summing. Nudging a fader re-runs only the cheap sum; the stem cache holds.
Clip-level `gain_db`/fades are baked into the stem (they are part of the
clip, i.e. part of the arrangement).

The `track-render` action key hashes the *resolved placement plan* — clip
windows already projected to samples through the tempo map — not the raw
ticks. So a tempo edit rebuilds exactly the tracks whose musical clips
actually moved, and absolute-anchored tracks ride through untouched.
Alternatives that lost: hashing raw clip YAML + the tempo file (every tempo
edit rebuilds every track, including pure-absolute ones); a single mix rule
with no per-track stems (any clip edit re-renders the whole song).

## 4 DSP decisions (DECIDED)

- **Sample-rate mismatch is a hard error, never implicit resampling.** A
  clip whose asset is not at the project rate fails the build with a message
  naming the fix. Silent resampling is hidden state — the visible fix (a
  normalize step, or re-import at the project rate) is one line and shows up
  in the diff.
- **Fades are linear, per-clip, inside the clip window.** A crossfade is two
  overlapping clips with fades — overlap sums, so crossfades compose from
  primitives instead of being a schema feature. Equal-power fade curves can
  arrive later as a `curve` field without disturbing this.
- **Pan is constant-power balance** on the stereo stem: unity at center,
  cosine taper of the opposite side toward the edges. Mono clip content is
  duplicated onto both stem channels.
- **Everything sums in Float32 with no clipping**; stems and the mix are
  written as Float32 WAV at the project rate. Headroom is the mixer's
  problem, loudness is a later phase's.
- **Out-of-range reads are silence**: a window that starts before the
  asset's first sample (slip > source_offset) or runs past its last plays
  silence there — slipping never errors, exactly like a DAW.
- **Takes are not mixed** in this phase; they are auditioned via `bloom
  play`. Comping a take into a clip is the recording phase's concern.

## 5 Chunks

1. **Track stems** (shipped, #9) — the `RuleImpl<T>` generic-registry
   refactor (the third rule is the agreed trigger, moved here from
   [ace-generation.md](ace-generation.md) §1 since mix now precedes ACE)
   plus multi-input rule contract, WAV read/write in TS, placement math,
   the `track-render` rule, and track `gain_db`/`pan` schema fields.
2. **The mix** — `mix.yaml`, the `mix` rule, rule→rule dependencies in the
   engine, and field's songs mixed and playable.
3. **Clips over rule outputs** — let a clip source a target's output
   (e.g. the SC pad render) instead of only a committed asset, completing
   recipes-over-samples: mix → stem → sc-render with no committed audio.
   This is also what makes "add a normalize target" a real fix for
   rate-mismatched assets.
