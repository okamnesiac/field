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
export class RemoteReads {
  private disabled = false;
  private readonly noticed = new Set<string>();
  fetched = 0; // entries this session brought in, for the reports
  fetchedBytes = 0;

  constructor(
    private readonly cache: RemoteCache,
    private readonly notice: (line: string) => void = (line) => process.stderr.write(`remote: ${line}\n`),
  ) {}

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
    if (err instanceof RemoteError) {
      if (err.kind === 'unreachable' || err.kind === 'refused' || err.kind === 'protocol') {
        this.disabled = true;
        this.say(err.kind, `${err.message}; building locally`);
        return;
      }
      this.say(`http:${err.status ?? ''}`, err.message);
      return;
    }
    this.disabled = true;
    this.say('unknown', `${(err as Error).message}; building locally`);
  }

  private say(key: string, line: string): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.notice(line);
  }
}
