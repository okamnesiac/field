# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **[One rendering pipeline](all/render-pipeline.md) chunk 4** — delete
  `src/audio/` minus `wav.ts`. After chunk 3 it executes nothing; the
  properties and the three goldens are what stand in its place.
- **[One rendering pipeline](all/render-pipeline.md) chunk 5** —
  sample-rate conversion in the built-in tier, retiring the last
  `afconvert` call and with it the nine platform-guarded tests.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
