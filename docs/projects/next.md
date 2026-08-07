# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **[One rendering pipeline](all/render-pipeline.md) chunk 3** — track
  inserts and the mix master chain move to the daemon too, retiring
  `src/audio/insert-chain.ts` as an executor. No `rule_version` bump: the
  C++ is byte-identical to the TypeScript, so nothing re-renders.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
