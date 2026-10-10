---
status: draft
priority: later
---

# Plan: prettier and ESLint

**Goal:** neither is installed and no config exists, so a tool reaching for a
formatter applies its own defaults (#83, 312 lines); ESLint is free,
prettier costs a ~5,200-line reformat across 86 of `src/`'s 132 files.

The figure is #88's probe, re-run on 2026-10-10 with prettier 3.9.9 on a
copy of `src/`, so the repository is never written to; #88 counted 1,916
lines across 40 files:

```sh
pnpm dlx prettier@3 --write --single-quote --print-width 100 'src/**/*.ts'
diff -ru <repo>/src src | grep -c '^[+-][^+-]'
```

No plan yet. This entry carries the line `later.md` held before the
Projector migration; write the plan here when the work graduates.
