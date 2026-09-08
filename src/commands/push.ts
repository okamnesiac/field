import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git.js';
import { explain, type ActionEntry, type Explanation } from '../graph/build.js';
import { buildGraph, resolveLabel } from '../graph/graph.js';
import { parseLabel, SONG_OUTPUT_NAME } from '../labels.js';
import { diagnosticErrors, findProjectRoot, loadProject } from '../model/project.js';
import { RemoteClient, RemoteError } from '../remote/client.js';
import { defaultCredentialStore, resolveToken, type CredentialStore } from '../remote/credentials.js';
import { originUrl, resolveProjectRemote, type ProjectRemote } from '../remote/origin.js';
import { formatBytes, gitConfigForRemote } from './clone.js';

// `field push [git args]` (remote.md §3.3): `git push` with the arguments
// passed through, then the artifact offer of audiofield-io.md §5.2 for
// the commit at HEAD: every rule entry beneath each song's `main` that
// this machine holds, sent with the commit and label it satisfies. The
// remote answers with the outputs it lacks, those are uploaded, and a
// completion call registers the entry. Nothing renders on push: an
// artifact the author never built is simply not offered.
//
// Every entry beneath `main` is offered, not only the ones the remote
// lacks, because the site indexes its player by commit and label
// (audiofield-io.md §5.7): an unchanged mix at a new commit needs a ref
// at that commit, and the remote asks for no upload when it already
// holds the bytes, so the cost of an offer it has is two small requests.

export interface PushOptions {
  cwd: string; // anywhere inside the project
  gitArgs?: string[] | undefined; // passed through to `git push`
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv | undefined;
  store?: CredentialStore | undefined;
  fetch?: typeof fetch | undefined;
  interactive?: boolean | undefined; // let git print progress
}

export interface OfferReport {
  song: string;
  offered: number; // entries announced for this song
  uploaded: number; // outputs whose bytes the remote lacked
  bytes: number; // bytes uploaded
  note?: string | undefined; // why the song was not offered, if it was not
}

export interface PushResult {
  root: string;
  commit: string; // HEAD after the push
  remote: ProjectRemote | undefined; // undefined: pushed somewhere Field has no API for
  offered: OfferReport[];
  note?: string | undefined; // why nothing was offered at all, if nothing was
}

export async function push(options: PushOptions): Promise<PushResult> {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.cwd);
  if (root === undefined) throw new Error('not inside a Field project (no field.yaml found)');
  const store = options.store ?? defaultCredentialStore();
  const resolution = resolveProjectRemote(root, env);
  const remote = resolution.kind === 'remote' ? resolution.remote : undefined;
  const token = remote === undefined ? undefined : resolveToken(remote.api, store, env)?.token;

  gitRemote('push', root, token, options.gitArgs ?? [], options.interactive ?? true);
  const commit = git(['rev-parse', 'HEAD'], { cwd: root });

  if (resolution.kind !== 'remote' || remote === undefined) {
    const why = resolution.kind === 'off' ? 'FIELD_REMOTE=off' : resolution.kind === 'none' ? resolution.reason : 'no remote';
    const note = `pushed; nothing offered (${why})`;
    options.out(note);
    return { root, commit, remote, offered: [], note };
  }
  // The keys are computed from the files on disk, and the offer says
  // they describe `commit`; with uncommitted changes that would be a
  // lie the site's player would repeat, so push, and say why not.
  if (git(['status', '--porcelain'], { cwd: root }) !== '') {
    const note = 'pushed; nothing offered: the working tree has uncommitted changes (commit them, then push again)';
    options.out(note);
    return { root, commit, remote, offered: [], note };
  }
  const client = new RemoteClient(remote.api, {
    token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const offered = await offerArtifacts(root, commit, remote, client, options.out);
  return { root, commit, remote, offered };
}

// `git <verb> <args>` with, when a token is held, the two things that
// let Git use it: the credential helper for the origin's host, passed
// per invocation so a project made by `field init` rather than `field
// clone` needs no configuration, and `http.proactiveAuth=basic` (Git
// 2.46+) so the token goes without a 401 round trip. Neither is
// persisted (remote.md §5 decision 13 as amended twice): "a token is
// held" is true only now.
export function gitRemote(verb: 'push' | 'pull', root: string, token: string | undefined, args: string[], interactive: boolean): void {
  git([...remoteGitConfig(originUrl(root), token), verb, ...args], { cwd: root, interactive });
}

// The `-c` pairs a push or pull carries, as a pure function of the origin
// and whether a token is held, so a test can assert on them without a
// network. Nothing without a token: an anonymous push of a public
// project is Git's own business.
export function remoteGitConfig(
  origin: string | undefined,
  token: string | undefined,
  helper: string = runningCliHelper(),
): string[] {
  if (token === undefined) return [];
  const config: string[] = [];
  if (origin !== undefined && /^https?:\/\//.test(origin)) {
    for (const [k, v] of gitConfigForRemote(origin)) config.push('-c', `${k}=${v === '' ? '' : helper}`);
  }
  config.push('-c', 'http.proactiveAuth=basic');
  return config;
}

// The helper as a shell command naming this very CLI, not whatever
// `field` resolves to on PATH. `clone` writes `!field git-credential`
// into a checkout because a path would go stale with the next install,
// but a push runs now: the first push against the live site was made
// from a checkout's dist/ while an older `field` sat on PATH, and Git
// was handed a helper without the subcommand. A script that is not
// compiled JavaScript — `tsx src/cli.ts` — cannot be re-run by node, so
// it falls back to the PATH form.
export function runningCliHelper(execPath: string = process.execPath, script: string | undefined = process.argv[1]): string {
  if (script !== undefined && /\.(c|m)?js$/.test(script)) return `!${shellQuote(execPath)} ${shellQuote(script)} git-credential`;
  return '!field git-credential';
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The offer, song by song: `explain` on `main` with no remote walks every
// rule node beneath it and reads the local cache for each, which is the
// same walk the warm makes in the other direction (commands/clone.ts).
export async function offerArtifacts(
  root: string,
  commit: string,
  remote: ProjectRemote,
  client: RemoteClient,
  out: (line: string) => void,
): Promise<OfferReport[]> {
  const project = loadProject(root);
  if (diagnosticErrors(project.diagnostics).length > 0) {
    out('nothing offered: the project has errors (field check)');
    return [];
  }
  const graph = buildGraph(project);
  const reports: OfferReport[] = [];
  for (const song of project.songs) {
    const report: OfferReport = { song: song.name, offered: 0, uploaded: 0, bytes: 0 };
    const memo = new Map<string, Explanation>();
    try {
      const main = resolveLabel(graph, parseLabel(`//${song.dir}/track:${SONG_OUTPUT_NAME}`));
      await explain(project, graph, main, memo);
    } catch (err) {
      // A song whose requests have no takes cannot key its nodes, and a
      // song with no `main` has nothing to offer; the message is the one
      // `build` would give.
      report.note = firstLine((err as Error).message);
      reports.push(report);
      out(describeOffer(report));
      continue;
    }
    try {
      for (const explanation of memo.values()) {
        if (explanation.kind !== 'rule' || explanation.actionKey === undefined || explanation.cached !== true) continue;
        const entry = readEntry(root, explanation.actionKey);
        if (entry === undefined) continue; // gone between the walk and now: not offered, not an error
        const uploads = await client.offer(remote.owner, remote.project, {
          commit,
          label: explanation.label,
          action_key: explanation.actionKey,
          rule: entry.rule,
          outputs: entry.outputs,
        });
        for (const upload of uploads) {
          const path = join(root, '.field', 'cache', 'cas', upload.sha256);
          await client.upload(upload.url, path);
          report.uploaded += 1;
          report.bytes += entry.outputs.find((o) => o.sha256 === upload.sha256)?.bytes ?? 0;
        }
        await client.complete(remote.owner, remote.project, explanation.actionKey);
        report.offered += 1;
      }
    } catch (err) {
      // The remote failed part way: what was completed is registered,
      // and the rest is offered again by the next push. Say which.
      report.note = err instanceof RemoteError ? err.message : firstLine((err as Error).message);
    }
    reports.push(report);
    out(describeOffer(report));
  }
  return reports;
}

// The entry as this machine's cache holds it, which is exactly what the
// remote stores (remote.md §4): read from disk rather than rebuilt from
// the explanation, so the offer and the local index cannot disagree.
function readEntry(root: string, actionKey: string): ActionEntry | undefined {
  const path = join(root, '.field', 'cache', 'actions', `${actionKey}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf8')) as ActionEntry;
    if (!entry.outputs.every((o) => existsSync(join(root, '.field', 'cache', 'cas', o.sha256)))) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

export function describeOffer(report: OfferReport): string {
  if (report.note !== undefined && report.offered === 0) return `${report.song}: not offered — ${report.note}`;
  const entries = `${report.offered} ${report.offered === 1 ? 'entry' : 'entries'}`;
  const uploads =
    report.uploaded === 0
      ? 'already on the remote'
      : `uploaded ${report.uploaded} ${report.uploaded === 1 ? 'output' : 'outputs'} (${formatBytes(report.bytes)})`;
  const partial = report.note !== undefined ? `; then stopped — ${report.note}` : '';
  return `${report.song}: offered ${entries}, ${uploads}${partial}`;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
