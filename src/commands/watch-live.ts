import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { sep } from 'node:path';
import type { Session } from '../audiod/session.js';
import { compileSession, diffSessions, type SessionEdit } from '../graph/live.js';

// The live half of watching (realtime.md chunk 3): recompile the song's
// session on every project change and classify the edit — the successor
// to the loop-wrap takeover, which waited for the wrap this loop never
// needs. Structured like watchBuild (watch.md §2): debounced, one
// compile in flight, stale re-runs, and a session that never dies on a
// mid-edit tree — a half-saved file reports and waits.

export interface WatchLiveHooks {
  // A compile succeeded and the edit is classified. `session` is the
  // fresh compile; the caller sends ramps or swaps it in.
  onEdit?: (edit: SessionEdit, session: Session) => void | Promise<void>;
  // The project failed to compile — diagnostics, a build error, a bad
  // tree. Last good session keeps playing; the next change retries.
  onError?: (err: Error) => void;
}

function relevant(filename: string): boolean {
  const top = filename.split(sep, 1)[0];
  return top !== '.field' && top !== '.git';
}

export async function watchLiveSession(
  root: string,
  song: string,
  baseline: Session,
  options: { debounceMs?: number; signal?: AbortSignal } = {},
  hooks: WatchLiveHooks = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 300;
  let current = baseline;
  let compiling = false;
  let stale = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const runBody = async (): Promise<void> => {
    if (compiling) {
      stale = true;
      return;
    }
    compiling = true;
    try {
      do {
        stale = false;
        let session: Session;
        try {
          session = await compileSession(root, song);
        } catch (err) {
          hooks.onError?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (options.signal?.aborted) return;
        if (stale) continue;
        const edit = diffSessions(current, session);
        current = session;
        await hooks.onEdit?.(edit, session);
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
  await done;
}
