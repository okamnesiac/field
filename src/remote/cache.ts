import { RemoteClient, RemoteError } from './client.js';
import type { RemoteArtifactEntry } from './protocol.js';
import type { ProjectRemote } from './origin.js';

// What the build engine sees of a remote (remote.md §3.4): a lookup by
// action key and a download by URL, and nothing about HTTP. The engine
// takes this at the same seam as the runner (remote.md §5 decision 11),
// so a test counts fetches the way it counts executions.
export interface RemoteCache {
  lookup(actionKey: string): Promise<RemoteArtifactEntry | undefined>;
  download(url: string, toPath: string): Promise<{ sha256: string; bytes: number }>;
}

export function projectCache(client: RemoteClient, remote: ProjectRemote): RemoteCache {
  return {
    lookup: (key) => client.fetchEntry(remote.owner, remote.project, key),
    download: (url, toPath) => client.download(url, toPath),
  };
}

// The read policy, kept out of the engine: a miss, an unreachable
// remote, a refused token, or a download whose hash disagrees all fall
// through to the render exactly as a local miss does — with one line on
// stderr for the unreachable and refused cases, once per build, so a
// slow network is visible without being fatal (remote.md §3.4). After
// that line the remote is not asked again this build: every later miss
// would print the same thing and wait for the same timeout.
export interface RemoteReadsOptions {
  notice?: ((line: string) => void) | undefined;
  // What the caller does after the remote fails — "building locally" for
  // a build. With one, a disabling failure prints once with that suffix;
  // without one, it does not print at all and the caller reads `failure`
  // and reports in its own words, which is what the warm does: it
  // builds nothing, so "building locally" would have been false there
  // and "nothing cached on the remote yet" after it falser still
  // (audiofield on #171).
  fallback?: string | undefined;
}

export class RemoteReads {
  private disabled = false;
  private readonly noticed = new Set<string>();
  private readonly notice: (line: string) => void;
  private readonly fallback: string | undefined;
  fetched = 0; // entries this session brought in, for the reports
  fetchedBytes = 0;
  // Why the remote stopped being asked, once it has: the message of the
  // unreachable, refused or protocol error, for a caller to report.
  failure: string | undefined;

  constructor(
    private readonly cache: RemoteCache,
    options: RemoteReadsOptions = {},
  ) {
    this.notice = options.notice ?? ((line) => process.stderr.write(`remote: ${line}\n`));
    this.fallback = options.fallback;
  }

  async lookup(actionKey: string): Promise<RemoteArtifactEntry | undefined> {
    if (this.disabled) return undefined;
    try {
      return await this.cache.lookup(actionKey);
    } catch (err) {
      this.fail(err);
      return undefined;
    }
  }

  // `undefined` when the download failed, after the same once-only
  // notice a failed lookup gets; the engine discards the partial file.
  async download(url: string, toPath: string): Promise<{ sha256: string; bytes: number } | undefined> {
    if (this.disabled) return undefined;
    try {
      return await this.cache.download(url, toPath);
    } catch (err) {
      this.fail(err);
      return undefined;
    }
  }

  // A download whose hash disagreed with the entry, reported by the
  // engine after it discarded the bytes. Said once per hash: the entry
  // is wrong on the remote, and every node that reads it would say so.
  mismatch(actionKey: string, sha256: string): void {
    this.say(`sha256:${sha256}`, `discarded a fetched output whose hash disagreed with its entry (${actionKey.slice(0, 12)})`);
  }

  // Bookkeeping for `clone`'s and `pull`'s reports: one entry, and the
  // bytes that were new to this machine.
  record(bytes: number): void {
    this.fetched += 1;
    this.fetchedBytes += bytes;
  }

  private fail(err: unknown): void {
    if (err instanceof RemoteError && err.kind === 'http') {
      this.say(`http:${err.status ?? ''}`, err.message);
      return;
    }
    const kind = err instanceof RemoteError ? err.kind : 'unknown';
    this.disabled = true;
    this.failure = (err as Error).message;
    if (this.fallback !== undefined) this.say(kind, `${this.failure}; ${this.fallback}`);
  }

  private say(key: string, line: string): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.notice(line);
  }
}
