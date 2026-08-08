# Build graph

Field treats a project as an explicit dependency graph, Bazel-style:
labels, dependencies, content-addressed outputs, incremental rebuilds,
cached outputs, queries, and tests — without Bazel syntax or its
vocabulary (project-layout.md §4: the format speaks sounds, types, and
sources; the engine speaks nodes, generators, and action keys).

```bash
field build //songs/opener/mix:main
field build //songs/opener/stems/...
field export //songs/opener/mix:main
field test //...
field query 'deps(//songs/opener/mix:main)'
field explain //songs/opener/mix:main
```

Labels address songs and shared material alike: a clip in one song
plays `//shared/asset:rain` exactly as it plays the song's own sounds.

The absolute form is canonical, but the CLI accepts songs-relative shorthand
for all of the above — `field build opener/mix:main`, `field explain
opener/...` — and a bare song name plays its main mix: `field play opener`
(project-core.md §3.4; `main` is a convention, and a song that names its
mixes otherwise gets a no-such-label error). `//shared/...` material
uses the full form.

## Caching, and freezing is caching

The cache key for a node's output is the hash of its inputs: input asset
hashes + plugin ID/version + serialized state + parameters + automation +
render-relevant settings. Same inputs → cached artifact returned, zero
renders.

There is no separate freeze machinery. **A frozen track is a cached
intermediate output**; invalidate the cache (change a parameter) and it is
unfrozen automatically. A bounce is a cached output given a name.
Outputs are stored under their content hash, so a rebuild never
overwrites an old render — it produces a new artifact and moves a pointer.

### Watch mode

The cache is what makes watching cheap
([watch.md](projects/all/watch.md)): `field build --watch <label>`
rebuilds on every settled change and answers "did anything audible
change" as an output-hash question — a fader move re-runs one sum, a
comment edit or `field fmt` pass is all cache hits and reports silence.
`check` gates every rebuild, so a red project (a half-saved file
mid-edit — the common case) keeps its last good outputs and retries on
the next change. `field play <song> --loop --watch` composes the same
loop with playback: when the playing label's hash moves, the daemon
finishes the current pass and the next wrap starts the new file. Watch
runs `build`, and build never generates a generative sound — but a
`chosen:` repoint is just a YAML edit, so `field choose` against a
running watch is live variant A/B-ing inside the loop.

### Getting a file out

Outputs live under their content hash, materialized at
`.field/out/<label>.wav` — addresses for the engine, not names anyone
wants in a Finder window or an email. `field export <patterns>` builds
and then copies the result to `~/Desktop` (or `--to <dir>`) under the
label with its punctuation flattened, minus the `songs/` prefix:
`//songs/creek/mix:main` becomes `creek-mix-main-v1.wav`, and shared
material keeps its shelf (`shared-asset-water-v1.wav`). It exports what
`play` would play, through the same resolver, and only the labels the
patterns match — the dependencies a build prints are means, not
products.

The name is long deliberately. A short form (`creek-main`) reads better
until a song has a track and a sound of the same name — legal, since the
one-namespace rule (project-layout.md §4.3) covers sounds and assets,
and natural when a track plays one sound — at which point two different
files want one name. A name that is sometimes scoped is worse than one
that always is: you cannot predict the file you are about to get.

**Exports are versioned, never overwritten.** Finishing something and
putting it somewhere is how people mark a version, and the previous one
is often the only copy of a decision later undone — so a second export
is `-v2`, numbered from the highest already there (a gap means someone
threw that version away, and minting a second `-v2` would disagree with
them). Re-exporting something that has not changed is a no-op: the bytes
are compared against *every* version present, newest first, and the
command reports `current` naming the version that stands rather than
minting an identical one. When the match is an older version — export
v1, change something, export v2, change it back — it reports `reverted`
and names both numbers, because the newest file in the directory is then
no longer what you just built.

Nothing Field does removes or overwrites a file in the destination,
including files it did not write. The copy lands on a temp name and is
linked into place, so an interrupted export leaves debris rather than a
truncated version (which, since nothing overwrites, would be permanent),
and a name that merely differs in case cannot be written through on a
case-insensitive volume — the link fails and the next number is taken.
A committed source whose bytes have drifted from their declared hash is
refused outright — the same guard `build` applies before consuming an
asset as an input. Export is the command whose product leaves the
machine, so it must not ship audio the project does not describe.

## Render strategies

How a node's output can be produced is a declared, per-node property:

- **`offline`** — renderable faster than realtime. Native AUs, SC non-realtime
  mode, most UAD-2 plugins (UAD-2 supports faster-than-realtime bounce, capped
  by DSP headroom).
- **`realtime-bounce`** — renderable only at 1×: Field plays through the graph
  and captures the result. The universal escape hatch — anything audible is
  freezable at 1×. Used for plugins that can't render offline and for external
  instruments (below).
- **`live-only`** — not renderable at all, because the node's output is not a
  pure function of the timeline: a live microphone input, a monitoring chain, a
  SuperCollider node played by hand, MIDI sent to an external device with no
  declared return. There is no answer to "what does this node output at bar
  42," so there is nothing to cache. A mix depending on a live-only node
  fails the build with a clear error: *this output doesn't exist until someone
  performs it — capture it first.* A capture of a live-only node's output is a
  take, and re-enters the buildable world.

**External instruments** graduate from live-only to realtime-bounce by
declaring an audio return path ("this device's output returns on Apollo inputs
3–4"): Field plays the MIDI at 1×, captures the return, caches it like any
other render — and flags it nondeterministic, because knobs on hardware are
outside the hash.

## Sound types and their generators

Every automatic type has a `Generator` in `src/generators/` — the code
that generates it mechanically, in-graph, cached. The `generative` type
has none: its generation is human-triggered (`field generate`), its
variants are committed under `audio/<sound>/`, and its label resolves
to the chosen variant (`field choose` repoints it; clips reference the
sound by name and follow).

- **`normalize`** — sample-rate/bit-depth conversion in the daemon's
  built-in tier: a fixed-ratio polyphase resampler and TPDF dither
  (projects/all/render-pipeline.md decisions 9 and 10), replacing macOS
  `afconvert` in chunk 5. `source:` is any committed or buildable name
  (verified against its declaration before the generator executes).
- **`supercollider`** — a SuperCollider program defines the sound,
  rendered offline via scsynth's NRT mode. `source:` names the program —
  a bare filename resolves in `shared/instruments/`, a slashed path is
  project-relative. The program is a plain `.scd` run through `sclang`
  with `FIELD_OUTPUT` / `FIELD_SEED` / `FIELD_DURATION` /
  `FIELD_SAMPLE_RATE` / `FIELD_CHANNELS` in the environment; it writes
  `FIELD_OUTPUT` and exits. The program's *content hash* is a cache input,
  so editing the code invalidates exactly its own renders; with a fixed
  seed, renders are reproducible bit-for-bit. `field sc render` runs a
  program directly (uncached) for iteration. Full contract:
  [projects/all/sc-render.md](projects/all/sc-render.md) §2 (the plan
  predates the §4 rename).
- **`say`** — **removed** (render-pipeline.md chunk 5). macOS
  text-to-speech was an in-graph recipe here: `text`/`voice`/`rate` as
  the whole action key, output cached and never committed. It went for
  two reasons that arrived together — it was the last rule shelling out
  to a macOS binary, and the generated-voice tier replaces what it was
  actually for.
  [projects/all/voice-generation.md](projects/all/voice-generation.md) §5
  records the decision and what it costs.

  Worth keeping from it: `say` was this document's example of the
  *hermetic* side of the determinism boundary, and the boundary itself is
  unchanged — `supercollider`, `eq`, `limit`, `reverb`, `normalize` and
  `stem` are all still recipes cached under an action key, while voice
  generation will be a deliberate generative sound with committed
  outputs on the other side. What `say` also demonstrated, less
  comfortably, is that a recipe can be *nearly* hermetic and that the
  gap is where the trouble lives: `voice: Siri` followed a Settings
  toggle the cache key could not see, and two consecutive CI renders of
  it were observed to differ.
- **`stem`** — the first *implicit* type: every audio track with clips
  is buildable as `//songs/<song>/track:<name>` without declaring
  anything, because the track file **is** the declaration — a mix file
  defines a `mix`, a track file implies a `stem`. A clip's
  `source:` is an asset, a sound, or a shared pin — clipping an
  automatic sound pulls its whole definition into the stem's subgraph,
  so the arrangement can play audio nothing ever committed, and editing
  the definition rebuilds straight through stem and mix. It places the
  track's clips through the tempo map (position, source offset, slip,
  clip gain, linear fades) and sums them into a pre-fader Float32 stereo
  stem, in TypeScript — offline mixing has no deadline
  ([projects/all/mix-assembly.md](projects/all/mix-assembly.md) §1). The
  action key hashes the *resolved placement plan* in samples, not the raw
  YAML: a tempo edit rebuilds exactly the tracks whose musical clips moved,
  reordering clips in the file changes nothing, and track `gain_db`/`pan`
  are excluded entirely — they are mix-stage parameters, so a fader move
  never re-renders a stem. Assets must already be at the project sample
  rate: Field never resamples implicitly (mix-assembly.md §4). A clip's
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
  Freeverb whose output grows by its tail. Each takes one `source:`, so
  chains are just sounds sourcing sounds — `supercollider → eq →
  reverb` — cached per link, and a sound wrapped in an effect is a
  different sound. The same parameters run as
  track `inserts:` (baked into the stem) and in the mix `master:` chain
  (post-gain, so the limiter guards the true output). Cycles became
  declarable with sound→sound edges, so `field check` names them.
- **`mix`** — declared one file per mix in `songs/<song>/mixes/`
  (`//songs/<song>/mix:<name>`; `field song create` writes a default
  `main`). Sums track stems — the
  graph's first rule→rule edges — applying each track's `gain_db`/`pan`
  (constant-power balance) and a master gain while summing. Because inputs
  are the stems' *content hashes*, a fader move re-runs only the sum, and a
  clip edit that leaves a stem byte-identical stops there: early cutoff
  falls out of content addressing. `tracks:` omitted means every audio
  track with clips; a mix with nothing to mix is legal and simply absent
  from the graph until content exists. A song may declare `length:`
  (`song.yaml`, in ticks or a musical span like `[12]` — see
  [project-model.md](project-model.md) "Timeline and tempo"): the mix
  then renders *exactly* that long — tails
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
versions — which is why generative sounds commit their variants, never
regenerating mechanically.

Nodes that can differ *audibly* between renders are flagged
**nondeterministic**, in three tiers:

1. Plugins with tempo-sync/retrigger LFO modes: Field prefers those modes and
   stores phase/offset as an explicit parameter — deterministic.
2. Free-running LFOs with an exposed rate/phase parameter: a per-plugin
   registry of known parameter mappings pins what's pinnable.
3. Truly free-running (some vintage emulations, deliberately): flagged in
   `field explain`; renders are handled as takes.

**Renders of nondeterministic nodes are takes** (see
[project-model.md](project-model.md)): numbered, auditioned, one active. A
rebuild that would replace the active render of a nondeterministic node
prompts first — or, in non-interactive/agent mode, auto-pins the outgoing
artifact so nothing is ever silently lost. Pinning is a named, GC-immune
reference to a content-addressed artifact — cheap, and reversible: repoint to
any retained take.
