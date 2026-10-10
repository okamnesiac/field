import { tryGit } from '../git.js';
import { cleartextReason } from './client.js';

// Which remote a project talks to (remote.md §5 decision 3): the origin,
// read from Git, with `FIELD_REMOTE` as the override. A project cloned
// from `https://git.audiofield.io/howlo/chemicals.git` already records
// where it came from, and no second file says the same thing — a
// `.field/remote` or a `git config field.remote` would drift the first
// time someone re-pointed origin.
//
// Two facts come out of one URL. The project is the last two path
// segments, `<owner>/<project>`, minus a `.git` suffix. The API base is
// derived from the host: git and LFS are served from `git.<apex>` and
// the API from `<apex>` (audiofield-io.md §10.9), so stripping the
// `git.` label is the whole mapping and works for a staging host too.
// `FIELD_REMOTE` replaces the API base and nothing else — it is how a
// test points a checkout cloned from a bare repository on disk at an
// in-process stub, and how anyone points at a staging site — and
// `FIELD_REMOTE=off` disables reads for a shell.

export interface ProjectRemote {
  api: string; // API base URL, no trailing slash
  owner: string;
  project: string;
}

export type RemoteResolution =
  | { kind: 'remote'; remote: ProjectRemote }
  | { kind: 'none'; reason: string }
  | { kind: 'off' };

// Splits a clone URL into its project slug and, when the host is an
// audiofield-shaped git host, the API base it implies. A URL of any
// other shape yields the slug alone when it has one, so `FIELD_REMOTE`
// can still supply the base.
export function parseCloneUrl(url: string): { slug?: { owner: string; project: string }; api?: string } {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // scp-like `git@host:owner/project.git`, or a bare path
    const m = /^(?:[^@]+@)?([^:/]+):(.+)$/.exec(url);
    if (m) {
      parsed = new URL(`ssh://${m[1]}/${m[2]}`);
    } else {
      parsed = new URL(`file://${url.startsWith('/') ? '' : '/'}${url}`);
    }
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '');
  const project = segments.at(-1)?.replace(/\.git$/, '');
  const owner = segments.at(-2);
  const slug = owner !== undefined && project !== undefined && project !== '' ? { owner, project } : undefined;
  const host = parsed.hostname;
  const candidate =
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') && host.startsWith('git.') && host.length > 4
      ? `${parsed.protocol}//${host.slice(4)}${parsed.port ? `:${parsed.port}` : ''}`
      : undefined;
  // A base the client would refuse is no base at all: an origin on plain
  // http anywhere but loopback gives the project no remote rather than a
  // remote every build fails against, because the scheme was inherited
  // from `git remote get-url`, not typed (remote.md §5 decision 12 as
  // amended). `FIELD_REMOTE` and `--remote` are typed, and the client
  // refuses those loudly instead.
  const api = candidate !== undefined && cleartextReason(candidate) === undefined ? candidate : undefined;
  return { ...(slug ? { slug } : {}), ...(api ? { api } : {}) };
}

export function originUrl(root: string): string | undefined {
  return tryGit(['remote', 'get-url', 'origin'], root);
}

export function resolveProjectRemote(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  origin: (root: string) => string | undefined = originUrl,
): RemoteResolution {
  const override = env['FIELD_REMOTE'];
  if (override === 'off') return { kind: 'off' };
  const url = origin(root);
  if (url === undefined) return { kind: 'none', reason: 'no git origin' };
  const parsed = parseCloneUrl(url);
  if (parsed.slug === undefined) {
    return { kind: 'none', reason: `origin ${url} has no <owner>/<project> path` };
  }
  const api = override !== undefined && override !== '' ? override.replace(/\/+$/, '') : parsed.api;
  if (api === undefined) {
    const cleartext = /^http:/.test(url) ? ' over plain http, which a remote must not be' : '';
    return { kind: 'none', reason: `origin ${url} is not an audiofield git host (git.<site>)${cleartext}` };
  }
  return { kind: 'remote', remote: { api, ...parsed.slug } };
}
