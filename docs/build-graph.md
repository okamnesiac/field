# Build graph

Bloom treats a project as an explicit dependency graph, Bazel-style: targets,
dependencies, content-addressed outputs, incremental rebuilds, cached outputs,
queries, and tests — without Bazel syntax.

```bash
bloom build //songs/opener/mix:main
bloom build //songs/opener/stems/...
bloom test //...
bloom query 'deps(//songs/opener/mix:main)'
bloom explain //songs/opener/mix:main
```

Labels address songs and shared material alike: a mix in one song can depend
on `//shared/instruments:dark-pad` exactly as it depends on its own tracks.

The absolute form is canonical, but the CLI accepts songs-relative shorthand
for all of the above — `bloom build opener/mix:main`, `bloom explain
opener/...` — and a bare song name plays its main mix: `bloom play opener`
(project-core.md §3.4; `main` is a convention, and a song that names its
mixes otherwise gets a no-such-target error). `//shared/...` material, when
it exists, uses the full form.

## Caching, and freezing is caching

The cache key for a node's output is the hash of its inputs: input asset
hashes + plugin ID/version + serialized state + parameters + automation +
render-relevant settings. Same inputs → cached artifact returned, zero
renders.

There is no separate freeze machinery. **A frozen track is a cached
intermediate output**; invalidate the cache (change a parameter) and it is
unfrozen automatically. A bounce is a cached output promoted to a named
target. Outputs are stored under their content hash, so a rebuild never
overwrites an old render — it produces a new artifact and moves a pointer.

## Render strategies

How a node's output can be produced is a declared, per-node property:

- **`offline`** — renderable faster than realtime. Native AUs, SC non-realtime
  mode, most UAD-2 plugins (UAD-2 supports faster-than-realtime bounce, capped
  by DSP headroom).
- **`realtime-bounce`** — renderable only at 1×: Bloom plays through the graph
  and captures the result. The universal escape hatch — anything audible is
  freezable at 1×. Used for plugins that can't render offline and for external
  instruments (below).
- **`live-only`** — not renderable at all, because the node's output is not a
  pure function of the timeline: a live microphone input, a monitoring chain, a
  SuperCollider node played by hand, MIDI sent to an external device with no
  declared return. There is no answer to "what does this node output at bar
  42," so there is nothing to cache. A mix target depending on a live-only node
  fails the build with a clear error: *this output doesn't exist until someone
  performs it — capture it first.* A capture of a live-only node's output is a
  take, and re-enters the buildable world.

**External instruments** graduate from live-only to realtime-bounce by
declaring an audio return path ("this device's output returns on Apollo inputs
3–4"): Bloom plays the MIDI at 1×, captures the return, caches it like any
other render — and flags it nondeterministic, because knobs on hardware are
outside the hash.

## Rules so far

- **`normalize`** — sample-rate/bit-depth conversion via macOS `afconvert`.
  Input: a declared asset (verified against its declaration before the rule
  executes).
- **`sc-render`** — a SuperCollider program renders an asset offline via
  scsynth's NRT mode. The program is a plain `.scd` run through `sclang`
  with `BLOOM_OUTPUT` / `BLOOM_SEED` / `BLOOM_DURATION` /
  `BLOOM_SAMPLE_RATE` / `BLOOM_CHANNELS` in the environment; it writes
  `BLOOM_OUTPUT` and exits. The program's *content hash* is a cache input,
  so editing the code invalidates exactly its own renders; with a fixed
  seed, renders are reproducible bit-for-bit. `bloom sc render` runs a
  program directly (uncached) for iteration. Full contract:
  [projects/all/sc-render.md](projects/all/sc-render.md) §2.
- **`track-render`** — the first *implicit* rule: every audio track with
  clips is buildable as `//songs/<song>/tracks:<name>` without declaring
  anything, because the track file **is** the declaration. A clip sources
  a committed asset *or a same-song target* — clipping an SC render pulls
  the whole recipe into the stem's subgraph, so the arrangement can play
  audio nothing ever committed, and editing the recipe rebuilds straight
  through stem and mix. It places the
  track's clips through the tempo map (position, source offset, slip,
  clip gain, linear fades) and sums them into a pre-fader Float32 stereo
  stem, in TypeScript — offline mixing has no deadline
  ([projects/all/mix-assembly.md](projects/all/mix-assembly.md) §1). The
  action key hashes the *resolved placement plan* in samples, not the raw
  YAML: a tempo edit rebuilds exactly the tracks whose musical clips moved,
  reordering clips in the file changes nothing, and track `gain_db`/`pan`
  are excluded entirely — they are mix-stage parameters, so a fader move
  never re-renders a stem. Assets must already be at the project sample
  rate: Bloom never resamples implicitly (mix-assembly.md §4). A clip's
  `loop:` map tiles its source to fill the window
  ([projects/all/clip-looping.md](projects/all/clip-looping.md)):
  repetitions expand into ordinary placement-plan entries — grid-locked
  via `loop.every`, cut or rung-out per `loop.mode`, seams click-guarded
  by `loop.fade` — so the renderer and action-key format don't know loops
  exist, and a loop hashes identically to its hand-tiled equivalent.
- **`eq` / `limit` / `reverb`** — the offline effects
  ([projects/all/effects.md](projects/all/effects.md)): Fyra's
  auto-normalizing EQ (RBJ biquads, bandwidth in octaves, response-based
  compensation on by default — tone changes, level doesn't), an offline
  lookahead limiter with a hard ceiling guarantee, and a deterministic
  Freeverb whose output grows by its tail. Each sources exactly one of
  `asset:`/`target:`, so chains are just targets referencing targets —
  `sc-render → eq → reverb` — cached per link. The same parameters run as
  track `inserts:` (baked into the stem) and in the mix `master:` chain
  (post-gain, so the limiter guards the true output). Cycles became
  declarable with target→target edges, so `bloom check` names them.
- **`mix`** — declared in `songs/<song>/mix.yaml` (`//songs/<song>/mix:<name>`;
  `bloom song create` writes a default `main`). Sums track stems — the
  graph's first rule→rule edges — applying each track's `gain_db`/`pan`
  (constant-power balance) and a master gain while summing. Because inputs
  are the stems' *content hashes*, a fader move re-runs only the sum, and a
  clip edit that leaves a stem byte-identical stops there: early cutoff
  falls out of content addressing. `tracks:` omitted means every audio
  track with clips; a mix with nothing to mix is legal and simply absent
  from the graph until content exists. A song may declare `length:`
  (ticks, `song.yaml`): the mix then renders *exactly* that long — tails
  truncate after the master chain, short content pads — so a song's
  extent is authored rather than emergent from whichever stem rings
  longest. Adding `loop: true` folds the overhang back onto the start
  instead (bar 12's reverb tail rings into bar 1): the render is one
  seamless pass of the infinite loop, and a looping song's length *is*
  its loop length.

## Determinism policy

**The contract is recipe-reproducibility, not bit-reproducibility.** Plugin
renders are not bit-identical across runs (modeled analog noise, dither,
floating-point scheduling) but sound the same; the build system never
re-renders unchanged inputs, so nondeterminism only surfaces on deliberate
cold rebuilds. Seeded SC renders are deterministic; ACE with a fixed seed is
reproducible on the same machine but not guaranteed across GPU/framework
versions — which is why generated assets are committed, not regenerated.

Nodes that can differ *audibly* between renders are flagged
**nondeterministic**, in three tiers:

1. Plugins with tempo-sync/retrigger LFO modes: Bloom prefers those modes and
   stores phase/offset as an explicit parameter — deterministic.
2. Free-running LFOs with an exposed rate/phase parameter: a per-plugin
   registry of known parameter mappings pins what's pinnable.
3. Truly free-running (some vintage emulations, deliberately): flagged in
   `bloom explain`; renders are handled as takes.

**Renders of nondeterministic nodes are takes** (see
[project-model.md](project-model.md)): numbered, auditioned, one active. A
rebuild that would replace the active render of a nondeterministic node
prompts first — or, in non-interactive/agent mode, auto-pins the outgoing
artifact so nothing is ever silently lost. Pinning is a named, GC-immune
reference to a content-addressed artifact — cheap, and reversible: repoint to
any retained take.
