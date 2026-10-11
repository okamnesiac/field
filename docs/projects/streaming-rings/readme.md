---
status: draft
priority: next
---

# Streaming rings

**Goal:** the live engine streams sources and track buffers through
bounded rings instead of preloading whole files and rendering every
track into a full-length buffer, so memory stops scaling with session
length times track count
([realtime.md](../realtime/readme.md) §7, chunk 2's 2026-08-10
amendment, measured creek at ~143 MB and extrapolated a five-minute
thirty-track session to ~3.5 GB).

No plan yet. Realtime recorded this as "owed before large sessions, not
an optimisation to forget", and it carries over from that plan's
completion; write the plan here when the work graduates.
