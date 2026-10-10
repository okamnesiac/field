import { spawnSync } from 'node:child_process';

// The one way Field spawns Git (remote.md §5 decision 10). `init` and
// `version` each had their own `execFileSync`/`spawnSync` and already
// disagreed on what a failure was — `init` threw Node's generic
// "Command failed" with Git's stderr buried in it, `version` returned
// `undefined` — and the remote verbs (clone, push, pull) were about to
// be a third and fourth spelling. So: one function that runs Git in a
// directory and hands back stdout, and throws Git's own stderr as the
// message when it fails, because Git's message ("fatal: repository
// 'x' does not exist") is the one worth reading.

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly status: number | null,
    readonly stderr: string,
  ) {
    super(stderr.trim() || `git ${args.join(' ')} exited with status ${status}`);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd: string;
  // Let Git talk to the terminal: clone and push print progress to
  // stderr and may prompt for credentials, and swallowing that would
  // turn a minute of LFS transfer into a silent hang. stdout is still
  // captured; only stderr and stdin pass through.
  interactive?: boolean;
}

// Runs `git <args>` in `cwd`, returns trimmed stdout, throws GitError on a
// non-zero exit. Git not being installed at all surfaces as an ENOENT
// spawn error with a message saying so, rather than a cryptic status.
export function git(args: string[], options: GitOptions): string {
  const r = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', options.interactive ? 'inherit' : 'pipe'],
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ENOENT' ? 'git is not installed (or not on PATH)' : r.error.message,
    );
  }
  if (r.status !== 0) throw new GitError(args, r.status, r.stderr ?? '');
  return r.stdout.trim();
}

// The forgiving form for probes — "is this a checkout", "what is HEAD" —
// where a failure means "no" rather than something to report. `version`
// wrote this shape by hand; it lives here so the throwing and the
// probing spelling cannot drift on what counts as failure.
export function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return git(args, { cwd });
  } catch {
    return undefined;
  }
}

// Whether `git lfs` answers. A clone without it lands pointer files
// where audio should be (remote.md §5 decision 6), so `clone` asks
// before touching the network; `init` asks the same question and only
// warns, because a new project has no audio yet.
export function gitLfsAvailable(cwd: string = process.cwd()): boolean {
  return tryGit(['lfs', 'version'], cwd) !== undefined;
}
