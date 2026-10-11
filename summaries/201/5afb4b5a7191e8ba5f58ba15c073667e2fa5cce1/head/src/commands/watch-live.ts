import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import type { Session } from '../audiod/session.js';
import { compileSession, diffSessions, type CompiledSession, type SessionEdit, type SessionInput } from '../graph/live.js';
import { buildLabels } from './build.js';

// The live half of watching (realtime.md chunk 3): recompile the song's
// session on every project change and classify the edit — the successor
// to the loop-wrap takeover, which waited for the wrap this loop never
// needs. Structured like watchBuild (watch.md §2): debounced, one
// compile in flight, stale re-runs, and a session that never dies on a
// mid-edit tree — a half-saved file reports and waits.
//
// This loop also runs the background half of the freeze (chunk 4,
// decision 4): whenever a compile reports dirty tracks — freeze
// candidates whose stems missed the cache — their stems rebuild behind
// the play, and the recompile that follows serves them as cached files.
// That swap is inaudible because live and offline are bit-identical,
// which is the whole point of decision 3.

export interface WatchLiveHooks {
  // A compile succeeded and the edit is classified. `session` is the
  // fresh compile; the caller sends ramps or swaps it in.
  onEdit?: (edit: SessionEdit, session: Session) => void | Promise<void>;
  // The project failed to compile — diagnostics, a build error, a bad
  // tree. Last good session keeps playing; the next change retries.
  onError?: (err: Error) => void;
  // A background stem build finished and the next compile will freeze
  // what it built — the note the display prints, nothing more.
  onFroze?: (labels: string[]) => void;
}

function relevant(filename: string): boolean {
  const top = filename.split(sep, 1)[0];
  return top !== '.field' && top !== '.git';
}

export async function watchLiveSession(
  root: string,
  song: string,
  baseline: CompiledSession,
  options: {
    debounceMs?: number;
    loop?: boolean;
    signal?: AbortSignal;
    // The open `field keys` inputs for the song, asked again at each
    // compile (live-supercollider.md chunk 3), so a reload keeps a routed
    // voice heard.
    inputs?: () => Promise<SessionInput[]>;
  } = {},
  hooks: WatchLiveHooks = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  let current = baseline.session;
  let compiling = false;
  let stale = false;
  let freezing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // Rebuild the dirty stems behind the play, then recompile: the next
  // compile finds them cached and freezes them. compileSession's dirty
  // list never names a track that cannot freeze (the output, a pre-tap
  // sender), so this converges — the compile after a successful build
  // reports the list empty. One build in flight; a failure reports and
  // waits for the next change rather than retrying into the same error.
  const refreeze = (dirty: string[]): void => {
    if (dirty.length === 0 || freezing || (options.signal?.aborted ?? false)) return;
    freezing = true;
    // The signal rides into the build and kills its render subprocess:
    // a ctrl-c mid-freeze must end the process now, not when the stem
    // finishes (Codex's finding). An abort surfaces as a rejection
    // here, which is the loop ending, not an error to report.
    void buildLabels(root, dirty, undefined, undefined, options.signal).then(
      () => {
        freezing = false;
        if (options.signal?.aborted ?? false) return;
        hooks.onFroze?.(dirty);
        onChange(null);
      },
      (err: unknown) => {
        freezing = false;
        if (options.signal?.aborted ?? false) return;
        hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );
  };

  const runBody = async (): Promise<void> => {
    if (compiling) {
      stale = true;
      return;
    }
    compiling = true;
    try {
      do {
        stale = false;
        let compiled: CompiledSession;
        try {
          const inputs = (await options.inputs?.()) ?? [];
          compiled = await compileSession(root, song, {
            ...(options.loop === true ? { loop: true } : {}),
            ...(inputs.length > 0 ? { inputs } : {}),
          });
        } catch (err) {
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (options.signal?.aborted) return;
        if (stale) continue;
        const edit = diffSessions(current, compiled.session);
        try {
          await hooks.onEdit?.(edit, compiled.session);
          // The baseline advances only once the daemon accepted the edit
          // (cursor's finding): a failed send keeps diffing against what
          // is actually playing, so the next change re-sends everything
          // outstanding — a ramp re-sent to its current value is a no-op.
          current = compiled.session;
          refreeze(compiled.dirty);
        } catch (err) {
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      } while (stale && !(options.signal?.aborted ?? false));
    } finally {
      compiling = false;
    }
  };

  const onChange = (filename: string | null): void => {
    if (options.signal?.aborted) return;
    if (filename !== null && !relevant(filename)) return;
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        void runBody().catch((err: unknown) =>
          hooks.onError?.(err instanceof Error ? err : new Error(String(err))),
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

  watcher = fsWatch(root, { recursive: true }, (_event, filename) => onChange(filename));
  // The play may have started with dirty tracks — freeze them without
  // waiting for an edit.
  refreeze(baseline.dirty);
  // An edit between the caller's baseline compile and this watcher
  // opening — a window that includes daemon connection and session
  // preloading — would otherwise wait for an unrelated later change
  // (Codex's finding). One recompile now catches it; an unchanged tree
  // diffs to `same` and lands nowhere.
  onChange(null);
  await done;
}
