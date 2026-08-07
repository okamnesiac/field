# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **[Linux portability](all/linux-portability.md) chunk 4** — the daemon
  behind `#if JUCE_MAC`, with a rescan fallback and a Linux CI build. First
  because it stopped being about Linux: once rendering moves into the daemon
  it is a build dependency, so this gates render chunks 3 and 6.
- **[One rendering pipeline](all/render-pipeline.md) chunk 2** — `juce_dsp`
  linked and the three effects written by hand in C++ behind the existing
  schemas, with chunk 1's fifteen properties green against the daemon.
  Chunk 6's compile flags and polynomial substitutions belong to the same
  pass, not a later one.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
