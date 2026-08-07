# Field

Field is a Mac-first, Git-native music production system designed to make an
entire music project operable by coding agents. The repository is the source of
truth, every meaningful action is a CLI command, agent-facing functionality is
exposed through MCP, and audio outputs are produced through an explicit
dependency graph and build process.

The closest analogy: **Bazel for music production**, combined with a real-time
recording runtime and an agent-native control layer.

## Install

Node 24 (the version in [`.nvmrc`](.nvmrc)) and pnpm — never npm or yarn.

```sh
pnpm install
pnpm build
pnpm add -g .
```

That puts `field` on your `PATH`. It needs pnpm's global bin directory to
already be on `PATH`; `pnpm setup` is what puts it there.

`pnpm add -g .` links this checkout rather than copying it, so a later
`pnpm build` takes effect with no re-linking. The same link is why `field`
works from any directory — including a songs project elsewhere on disk — and
why there is only ever one copy to keep current.

To run from source without installing anything: `pnpm field <args>`.
To remove the global command: `pnpm remove -g field`.

### The audio daemon

`field-audiod` is a separate native binary (CMake and JUCE), built by:

```sh
pnpm build:native
```

Build it before playing anything. Without it `field play` falls back to
`afplay`, `field devices` fails, and the options that need a real-time
transport — `--from`, `--device`, `--loop`, `--click`, `--watch` — refuse to
run rather than pretending.

The CLI looks for the binary inside the checkout it was linked from, so one
build serves every project directory. `FIELD_AUDIOD` overrides that path.

This step is macOS-only (CoreAudio), which is why CI does not run it.

## Documentation

- [Overview](docs/overview.md) — the thesis, core concepts, and V1 scope
- [Architecture](docs/architecture.md) — layers, processes, and language decisions
- [Project model](docs/project-model.md) — the canonical on-disk representation
- [Build graph](docs/build-graph.md) — targets, caching, freezing, determinism
- [Audio engine](docs/audio-engine.md) — the real-time daemon (future work)
- [Projects](docs/projects/README.md) — work in progress, next, and later
