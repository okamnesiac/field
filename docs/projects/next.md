# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **[One rendering pipeline](all/render-pipeline.md)** — the daemon becomes
  the single executor for rendered audio, because an insert chain holding an
  `au:` plugin cannot be rendered by TypeScript.
- **[Linux portability](all/linux-portability.md)** — the daemon behind
  `#if JUCE_MAC`; the CI split shipped (#46) and the rest of the plan moved
  to render-pipeline.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
