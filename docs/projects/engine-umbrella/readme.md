---
status: completed
---

**Outcome:** Abandoned. [audio-engine.md](../../audio-engine.md) uses
"engine" for `field-audiod`, so a TypeScript `src/engine` would point a
reader at the wrong process, and `src/` has since grown `audiod/`,
`remote/`, `time/` and `workers/` beside `graph/` and `generators/`
without anything needing them gathered.

# Plan: src/engine umbrella

**Goal:** `graph/` + `generators/` (+ `audio/`?) under one engine module;
discussed 2026-08-06, no flag-day pressure, land as a quiet cleanup
whenever.

No plan yet. This entry carries the line `later.md` held before the
Projector migration; write the plan here when the work graduates.
