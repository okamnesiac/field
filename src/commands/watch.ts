import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import { parsePattern } from '../labels.js';
import { loadProject } from '../model/project.js';
import { build, type BuildOutcome, type GeneratorRunner } from '../graph/build.js';
import { buildGraph, expandPattern } from '../graph/graph.js';

// bloom build --watch (watch.md §2): rebuild the given labels every time
// the project changes, and say which outputs audibly moved. The loop body
// never diffs files or reasons about what an edit meant — it check-gates,
// rebuilds through the normal engine, and compares output hashes (§1.3):
// hash moved ⇒ changed, hash same ⇒ silence. A red project keeps the last
// good outputs and waits (§1.2) — a half-saved file mid-edit is the common
// case, not an error case.

export interface WatchHooks {
  // The project failed check: last good outputs stand, the next change
  // retries. Lines are "file: message", one per diagnostic.
  onDiagnostics?: (lines: string[]) => void;
  // A build completed: all outcomes, plus the ones whose output hash moved
  // since the last good build (empty on the baseline-setting first build).
  onOutcomes?: (outcomes: BuildOutcome[], changed: BuildOutcome[]) => void;
  // Something threw: last good outputs stand, the next change retries.
  // The phase says what failed — 'load' (the loader crashed on a bad
  // tree), 'build' (a generator error, a label that no longer resolves),
  // or 'watch' (the last-resort catch) — so the report never blames the
  // build for a loader crash (#34 review footnote).
  onError?: (err: Error, phase: 'load' | 'build' | 'watch') => void;
}

export interface WatchOptions {
  debounceMs?: number; // write-burst coalescing, default 300
  signal?: AbortSignal; // ends the session; the returned promise resolves
  runner?: GeneratorRunner;
  // Seed hash baseline (label → sha256). When provided, the first build
  // compares against it instead of silently baselining — play --watch
  // passes what the daemon started looping, so an edit landing between
  // the play's own build and the watcher's first pass is reported and
  // swapped, not absorbed (#35 review).
  baseline?: ReadonlyMap<string, string>;
}

// Everything except the build's own output and git's: watching .bloom/
// would self-trigger forever (§2), and .git/ churns on every command.
function relevant(filename: string): boolean {
  const top = filename.split(sep, 1)[0];
  return top !== '.bloom' && top !== '.git';
}

// Watches root and rebuilds patterns until the signal aborts. The first
// build runs immediately and establishes the hash baseline. Only one build
// is ever in flight: a change landing mid-build marks it stale — its
// artifacts still land in the CAS (warm for later), but its report is
// discarded and the body re-runs against the fresh tree (§2 coalescing).
export async function watchBuild(
  root: string,
  patterns: string[],
  options: WatchOptions = {},
  hooks: WatchHooks = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  const lastGood = new Map<string, string>(options.baseline ?? []); // label → sha256
  // True once a full build has recorded every matched label. A seed only
  // speaks for the labels it names: seeded labels compare immediately,
  // while their dependencies baseline silently on the first build — only
  // after a full baseline does a newly appearing label count as changed.
  let fullBaseline = false;
  let building = false;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const runBody = async (): Promise<void> => {
    if (building) {
      stale = true;
      return;
    }
    building = true;
    try {
      do {
        stale = false;
        // Guarded like the build below: the loader reads a tree that is by
        // definition mid-edit (a dangling symlink, a file where a directory
        // belongs, a checkout mid-flight), and a throw here must be a
        // report-and-wait, not the end of the session (§1.2 — the watch
        // never dies on a bad tree).
        let project: ReturnType<typeof loadProject>;
        try {
          project = loadProject(root);
        } catch (err) {
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)), 'load');
          continue;
        }
        if (options.signal?.aborted) return;
        if (project.diagnostics.length > 0) {
          hooks.onDiagnostics?.(project.diagnostics.map((d) => `${d.file}: ${d.message}`));
          continue; // wait for the next change (or the stale re-run)
        }
        let outcomes: BuildOutcome[];
        try {
          const graph = buildGraph(project);
          const nodes = patterns.flatMap((p) => expandPattern(graph, parsePattern(p)));
          outcomes = await build(project, graph, nodes, options.runner);
        } catch (err) {
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)), 'build');
          continue;
        }
        // An abort landing mid-build must not report: the session is
        // over, and play --watch's reload socket is already closed —
        // edit-then-ctrl-c is an ordinary way to quit (#35 review).
        if (options.signal?.aborted) return;
        if (stale) continue; // a mid-build change: report nothing, go again
        const changed = outcomes.filter((o) => {
          const prev = lastGood.get(o.label);
          return prev !== undefined ? prev !== o.sha256 : fullBaseline;
        });
        lastGood.clear();
        for (const o of outcomes) lastGood.set(o.label, o.sha256);
        fullBaseline = true;
        hooks.onOutcomes?.(outcomes, changed);
      } while (stale && !(options.signal?.aborted ?? false));
    } finally {
      building = false;
    }
  };

  const onChange = (filename: string | null): void => {
    if (options.signal?.aborted) return;
    if (filename !== null && !relevant(filename)) return;
    clearTimeout(timer);
    // The catch is a last resort (loader and build throws are already
    // routed above): a rejection escaping the timer would be unhandled
    // and kill the process — the one thing a watch must never do.
    timer = setTimeout(
      () =>
        void runBody().catch((err: unknown) =>
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)), 'watch'),
        ),
      debounceMs,
    );
  };

  const close = (): void => {
    clearTimeout(timer);
    watcher?.close();
    finish();
  };
  if (options.signal?.aborted) return;
  options.signal?.addEventListener('abort', close, { once: true });

  // FSEvents under the hood — recursive fs.watch is solid on macOS, and
  // macOS is the charter.
  watcher = fsWatch(root, { recursive: true }, (_event, filename) => onChange(filename));
  await runBody();
  await done;
}
