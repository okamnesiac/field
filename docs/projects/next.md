# Next

Coming up, not started, in rough order. One line each, linking a plan in
[all](all/) where there is one. Move a line to [now](now.md) when the work
begins, or down to [later](later.md) if it turns out bigger than expected. See
[README](README.md) for how these lists work.

- **Voice generation** — the other side of the determinism boundary from
  the `say` rule (kept separate by design): a generation workflow like
  ACE — committed outputs, recipe provenance, variants/choose. Local-first
  in the `bloom-aced` pattern: 2026 open models (Chatterbox, Qwen3-TTS,
  CosyVoice 3) sit within ~80 ELO of ElevenLabs, and zero-shot cloning
  means a "voice" is a committed 3-second reference asset, not a model
  download — better provenance than a vendor voice ID. ElevenLabs as an
  optional keyed backend only if a specific voice demands it.
- **MCP surface** — expose the CLI's verbs as MCP tools once project core
  gives them stable shapes; agents are a first-class user from early on.
