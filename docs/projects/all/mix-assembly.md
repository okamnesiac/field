# Plan: Offline mix assembly

**Status:** Planned, not started. Follows
[ace-generation.md](ace-generation.md); the first listenable `//mix` target.

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
