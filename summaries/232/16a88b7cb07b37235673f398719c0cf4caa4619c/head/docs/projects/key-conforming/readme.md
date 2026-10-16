---
status: draft
priority: later
---

# Getting imported material into key

**Goal:** imported material moves into the song's key in one step. Audio
takes a model as the default path for transposition and time-stretch
rather than a fallback behind an arithmetic one, and a sequenced part
transposes its notes.

No plan yet. Picked on 2026-08-20 from
[daw-features §15](../daw-features/readme.md) ("Getting imported material
into key"), which splits the work in two: detecting the key belongs on
[analysis-workers](../analysis-workers/readme.md), and conforming is a
transform whose default for audio is the model and for a part is
arithmetic (corrected 2026-10-15, with the
[sequencer](../sequencer/readme.md)). Write the plan here when the work
graduates.
