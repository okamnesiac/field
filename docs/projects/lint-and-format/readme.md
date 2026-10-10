---
status: draft
priority: later
---

# Plan: prettier and ESLint

**Goal:** neither is installed and no config exists, so a tool reaching for a
formatter applies its own defaults (#83, 312 lines); ESLint is free,
prettier costs a ~5,200-line reformat across 86 of `src/`'s 132 files.

The figure is #88's probe, re-run on 2026-10-10 with prettier 3.9.9; #88
counted 1,916 lines across 40 files. Run it from the repository root. It
copies `src/` into a temporary directory and reformats only the copy, so
the repository is never written to. It prints the changed lines, `5209`,
then the changed files, `86`:

```sh
probe="$(mktemp -d)" && cp -R src "$probe/"
pnpm dlx prettier@3 --write --single-quote --print-width 100 "$probe/src/**/*.ts" >/dev/null
diff -ru src "$probe/src" | grep -c '^[+-][^+-]'
diff -rq src "$probe/src" | wc -l
```

No plan yet. This entry carries the line `later.md` held before the
Projector migration; write the plan here when the work graduates.
