import { git } from '../git.js';
import { findProjectRoot } from '../model/project.js';
import { RemoteClient } from '../remote/client.js';
import { defaultCredentialStore, resolveToken, type CredentialStore } from '../remote/credentials.js';
import { resolveProjectRemote, type ProjectRemote } from '../remote/origin.js';
import { warmCache, type WarmReport } from './clone.js';
import { gitRemote } from './push.js';

// `field pull [git args]` (remote.md §3.3): `git pull` with the arguments
// passed through, then the warm `field clone` does, for the HEAD the
// pull left behind, so the next build is hits for whatever the remote
// holds at that commit. Plain `git pull` keeps working; it just skips
// the warm, and the next `field build` reads through per miss instead.

export interface PullOptions {
  cwd: string;
  gitArgs?: string[] | undefined;
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv | undefined;
  store?: CredentialStore | undefined;
  fetch?: typeof fetch | undefined;
  interactive?: boolean | undefined;
}

export interface PullResult {
  root: string;
  commit: string; // HEAD after the pull
  remote: ProjectRemote | undefined;
  warmed: WarmReport[];
  note?: string | undefined;
}

export async function pull(options: PullOptions): Promise<PullResult> {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.cwd);
  if (root === undefined) throw new Error('not inside a Field project (no field.yaml found)');
  const store = options.store ?? defaultCredentialStore();
  const resolution = resolveProjectRemote(root, env);
  const remote = resolution.kind === 'remote' ? resolution.remote : undefined;
  const token = remote === undefined ? undefined : resolveToken(remote.api, store, env)?.token;

  gitRemote('pull', root, token, options.gitArgs ?? [], options.interactive ?? true);
  const commit = git(['rev-parse', 'HEAD'], { cwd: root });

  if (resolution.kind !== 'remote' || remote === undefined) {
    const why = resolution.kind === 'off' ? 'FIELD_REMOTE=off' : resolution.kind === 'none' ? resolution.reason : 'no remote';
    const note = `pulled; cache not warmed (${why})`;
    options.out(note);
    return { root, commit, remote, warmed: [], note };
  }
  const client = new RemoteClient(remote.api, {
    token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const warmed = await warmCache(root, remote, client, options.out);
  return { root, commit, remote, warmed };
}
