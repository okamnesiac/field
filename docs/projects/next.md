# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **[Linux portability](all/linux-portability.md)** — the CI split with
  per-test platform guards, first because #46 left CI running no tests at
  all; then the daemon behind `#if JUCE_MAC`.
- **[One rendering pipeline](all/render-pipeline.md)** — the daemon becomes
  the single executor for rendered audio, because an insert chain holding an
  `au:` plugin cannot be rendered by TypeScript. Sequenced after the CI split
  above: its first chunk adds properties to the renderer it is about to
  replace, and those want a suite that actually runs behind them.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
