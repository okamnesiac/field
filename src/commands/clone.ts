import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { git, gitLfsAvailable } from '../git.js';
import { explain } from '../graph/build.js';
import { buildGraph, resolveLabel } from '../graph/graph.js';
import { parseLabel, SONG_OUTPUT_NAME } from '../labels.js';
import { diagnosticErrors, loadProject } from '../model/project.js';
import { RemoteReads, projectCache } from '../remote/cache.js';
import { RemoteClient } from '../remote/client.js';
import { defaultCredentialStore, resolveToken, type CredentialStore } from '../remote/credentials.js';
import { parseCloneUrl, type ProjectRemote } from '../remote/origin.js';
import { DEFAULT_REMOTE, remoteName } from '../remote/protocol.js';

// `field clone <owner>/<project> [dir]` (remote.md §3.2): expand the
// short name to the clone URL the remote reports, run `git clone` (LFS
// included), then warm the cache for every song's `main` and every rule
// node beneath it — the index as well as the bytes, because readAction
// is what makes a hit, and the whole closure rather than `main` alone,
// because a node's key is computed from its dependencies' output hashes
// and a clone holding only the mix would rebuild every stem before it
// could ask whether the mix was cached (audiofield-io.md §6).
//
// Everything the warm writes lands under .field/, which init gitignores,
// so a warmed checkout is a clean one (bloom-in-tree.md §7).

export interface CloneOptions {
  target: string; // <owner>/<project>, or a full clone URL
  dir?: string | undefined;
  cwd: string;
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv | undefined;
  store?: CredentialStore | undefined;
  fetch?: typeof fetch | undefined;
  lfsAvailable?: (() => boolean) | undefined;
  interactive?: boolean | undefined; // let git print progress
}

export interface WarmReport {
  song: string;
  fetched: number; // entries brought in for this song
  bytes: number;
  note?: string | undefined; // why the song could not be warmed, if it could not
}

export interface CloneResult {
  dir: string; // absolute
  cloneUrl: string;
  remote: ProjectRemote | undefined; // undefined: cloned from somewhere Field has no API for
  warmed: WarmReport[];
}

const SHORT_NAME = /^([^/\s]+)\/([^/\s]+)$/;

export async function clone(options: CloneOptions): Promise<CloneResult> {
  const env = options.env ?? process.env;
  // Refuse before touching the network (remote.md §5 decision 6): a
  // clone without LFS lands pointer files where audio should be, and the
  // first `field check` then fails every ledger row with a hash mismatch
  // that looks like corruption.
  if (!(options.lfsAvailable ?? gitLfsAvailable)()) {
    throw new Error(
      'git-lfs is required to clone a Field project — without it, audio arrives as pointer files. ' +
        'Install it (brew install git-lfs, or your package manager) and run `git lfs install`, then retry.',
    );
  }

  const store = options.store ?? defaultCredentialStore();
  const clientFor = (api: string) =>
    new RemoteClient(api, {
      token: resolveToken(api, store, env)?.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  let cloneUrl: string;
  let remote: ProjectRemote | undefined;
  const short = SHORT_NAME.exec(options.target);
  if (short && !options.target.includes(':')) {
    const [, owner, project] = short as unknown as [string, string, string];
    if (!remoteName.safeParse(owner).success || !remoteName.safeParse(project).success) {
      throw new Error(`"${options.target}" is not an <owner>/<project> name (lowercase slugs) or a clone URL`);
    }
    const override = env['FIELD_REMOTE'];
    const api = override !== undefined && override !== '' && override !== 'off' ? override.replace(/\/+$/, '') : DEFAULT_REMOTE;
    const info = await clientFor(api).resolveProject(owner, project);
    if (info === undefined) {
      // A private project the token cannot see answers the same 404 as
      // one that does not exist (audiofield-io.md §9.9), so say both.
      throw new Error(`no project ${owner}/${project} on ${api} — or it is private and you are not logged in (field login)`);
    }
    cloneUrl = info.clone_url;
    remote = { api, owner, project };
  } else {
    // A full URL is accepted where a short name is expected, so a
    // project hosted anywhere Git reaches can still be cloned; only the
    // short form and the warm depend on the remote's API.
    cloneUrl = options.target;
    const parsed = parseCloneUrl(cloneUrl);
    const override = env['FIELD_REMOTE'];
    const api =
      override !== undefined && override !== '' && override !== 'off' ? override.replace(/\/+$/, '') : parsed.api;
    remote = api !== undefined && parsed.slug !== undefined ? { api, ...parsed.slug } : undefined;
  }

  const dirName = options.dir ?? basename(cloneUrl.replace(/\/+$/, '')).replace(/\.git$/, '');
  const dir = resolve(options.cwd, dirName);
  if (existsSync(dir)) throw new Error(`destination ${dirName} already exists`);

  options.out(`cloning ${cloneUrl} into ${dirName}`);
  // `-c` sets the variable in the new repository's config before the
  // fetch, so it applies to this clone and persists for every later
  // push and pull. proactiveAuth (git 2.46+) sends the token without a
  // 401 probe first; the helper is `field git-credential`, so Git and the
  // API share one stored token (audiofield-io.md §5.5). Only for a host
  // Field recognizes — a clone from GitHub gets Git's own defaults.
  const config = remote !== undefined && /^https?:\/\//.test(cloneUrl) ? gitConfigForRemote(cloneUrl) : [];
  git(['clone', ...config.flatMap(([k, v]) => ['-c', `${k}=${v}`]), cloneUrl, dir], {
    cwd: options.cwd,
    interactive: options.interactive ?? true,
  });

  const warmed = remote === undefined ? [] : await warmCache(dir, remote, clientFor(remote.api), options.out);
  return { dir, cloneUrl, remote, warmed };
}

// The config a clone from an audiofield git host carries, as pairs, so a
// test can assert on the list without cloning over HTTP.
export function gitConfigForRemote(cloneUrl: string): [string, string][] {
  const url = new URL(cloneUrl);
  return [
    ['http.proactiveAuth', 'basic'],
    [`credential.${url.protocol}//${url.host}.helper`, '!field git-credential'],
  ];
}

// Fetch the action entries and outputs for every song's `main` and the
// rule nodes beneath it. `explain` with a remote does exactly that walk
// (graph/build.ts), so the warm is explain per song plus bookkeeping.
export async function warmCache(
  dir: string,
  remote: ProjectRemote,
  client: RemoteClient,
  out: (line: string) => void,
): Promise<WarmReport[]> {
  const project = loadProject(dir);
  if (diagnosticErrors(project.diagnostics).length > 0) {
    out('cache not warmed: the project has errors (field check)');
    return [];
  }
  const graph = buildGraph(project);
  const reads = new RemoteReads(projectCache(client, remote), (line) => out(`remote: ${line}`));
  const reports: WarmReport[] = [];
  for (const song of project.songs) {
    const before = { fetched: reads.fetched, bytes: reads.fetchedBytes };
    const report: WarmReport = { song: song.name, fetched: 0, bytes: 0 };
    try {
      const main = resolveLabel(graph, parseLabel(`//${song.dir}/track:${SONG_OUTPUT_NAME}`));
      await explain(project, graph, main, new Map(), reads);
    } catch (err) {
      // A song whose requests have no takes cannot key its nodes, so the
      // remote cannot be asked for them (remote.md §9.11); a song with no
      // `main` has nothing to warm. Either way the message is the one
      // `build` would give, said now.
      report.note = firstLine((err as Error).message);
    }
    report.fetched = reads.fetched - before.fetched;
    report.bytes = reads.fetchedBytes - before.bytes;
    reports.push(report);
    out(describeWarm(report));
  }
  return reports;
}

export function describeWarm(report: WarmReport): string {
  if (report.note !== undefined) return `${report.song}: not warmed — ${report.note}`;
  if (report.fetched === 0) return `${report.song}: nothing cached on the remote yet`;
  return `${report.song}: fetched ${report.fetched} artifact${report.fetched === 1 ? '' : 's'} (${formatBytes(report.bytes)})`;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
