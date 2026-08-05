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
