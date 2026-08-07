# Field

Field is a Mac-first, Git-native music production system designed to make an
entire music project operable by coding agents. The repository is the source of
truth, every meaningful action is a CLI command, agent-facing functionality is
exposed through MCP, and audio outputs are produced through an explicit
dependency graph and build process.

The closest analogy: **Bazel for music production**, combined with a real-time
recording runtime and an agent-native control layer.

## Documentation

- [Overview](docs/overview.md) — the thesis, core concepts, and V1 scope
- [Architecture](docs/architecture.md) — layers, processes, and language decisions
- [Project model](docs/project-model.md) — the canonical on-disk representation
- [Build graph](docs/build-graph.md) — targets, caching, freezing, determinism
- [Audio engine](docs/audio-engine.md) — the real-time daemon (future work)
- [Projects](docs/projects/README.md) — work in progress, next, and later
