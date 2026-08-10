import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from '../packageVersion.js';
import { socketPathFor } from '../socketPath.js';
import {
  DAEMON_NAME as AUDIOD_NAME,
  PROTOCOL_VERSION as AUDIOD_PROTOCOL_VERSION,
  SOCKET_RELATIVE as AUDIOD_SOCKET,
} from '../audiod/protocol.js';
import { SETUP_SPECS } from './generate.js';
import { WORKER_PROTOCOL_VERSION } from '../workers/protocol.js';

// `field --version`: which build is running, and which build each daemon is
// running. Those are different questions and the second one is the one
// that bites — a daemon outlives the CLI that spawned it by design, so
// the process answering may predate the code asking by hours.
//
// Every version in this system was a hardcoded "0.1.0" until now, which
// answers neither. Two things happened in one day to prove it: a
// field-voiced started before the delivery knobs existed accepted
// `--exaggeration` and silently dropped it, and a venv held a stale copy
// of field_worker while the CLI read the source. Both were invisible,
// and both would have been one command to see.

export interface DaemonReport {
  name: string;
  running: boolean;
  version?: string | undefined; // as the daemon reports it, not as we assume
  protocol?: number | undefined;
  socket: string; // project-relative
  note?: string | undefined; // why it is not running, or why it disagrees
}

export interface VersionReport {
  cli: {
    version: string;
    commit?: string | undefined;
    branch?: string | undefined;
    dirtyFiles?: number | undefined;
    // Set when the artifact's baked identity and the checkout's HEAD
    // disagree — the stale-dist case --version exists to catch.
    checkoutCommit?: string | undefined;
    // Set when HEAD matches but the working tree's dirty count moved
    // since the build: edits without a commit also go stale.
    checkoutDirtyFiles?: number | undefined;
  };
  workerProtocol: number;
  daemons: DaemonReport[];
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Build identity, which is what "which version am I running" actually
// means during development: a release number moves once a release, and
// the thing that changed under you moved twenty minutes ago. Absent when
// this is not a git checkout, which is honest rather than a fallback to
// something invented.
interface BuildIdentity {
  commit?: string | undefined;
  branch?: string | undefined;
  dirtyFiles?: number | undefined;
  checkoutCommit?: string | undefined;
  checkoutDirtyFiles?: number | undefined;
}

function liveIdentity(): BuildIdentity {
  const git = (args: string[]): string | undefined => {
    const r = spawnSync('git', ['-C', packageRoot(), ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  // Full sha, compared exactly — --short lengthens as the repo grows,
  // so equal objects can compare unequal as strings (Bugbot on #121).
  const commit = git(['rev-parse', 'HEAD']);
  if (commit === undefined) return {};
  const status = git(['status', '--porcelain']);
  return {
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyFiles: status === undefined ? undefined : status.split('\n').filter((l) => l.trim()).length,
  };
}

// The artifact reports what it was BUILT from — `pnpm build` stamps
// dist/build-info.json (scripts/stamp-build.mjs) — because the checkout
// moves the moment a branch is switched, and a --version that reads
// HEAD at invocation describes code that is not running (it reported a
// branch whose message changes the installed dist did not contain, and
// the confusion cost a debugging round, 2026-08-09). Running from
// source (tsx, vitest) keeps the live read: there the checkout IS the
// code. An unstamped dist — a build from before this — falls back to
// the live read, the old behavior rather than a crash.
export function resolveIdentity(stamped: BuildIdentity, live: BuildIdentity): BuildIdentity {
  const commitDrift =
    live.commit !== undefined && stamped.commit !== undefined && live.commit !== stamped.commit;
  // Same commit but a different dirty count is drift too: build from a
  // clean tree, edit without committing, and HEAD never moves while the
  // running code goes stale (Codex on #121). The count is the affordable
  // signal — equal counts over different edits stay invisible, which a
  // build-input fingerprint would catch and this deliberately does not.
  const dirtyDrift =
    !commitDrift &&
    live.commit !== undefined &&
    (live.dirtyFiles ?? 0) !== (stamped.dirtyFiles ?? 0);
  return {
    ...stamped,
    ...(commitDrift ? { checkoutCommit: live.commit } : {}),
    ...(dirtyDrift ? { checkoutDirtyFiles: live.dirtyFiles ?? 0 } : {}),
  };
}

function buildIdentity(): BuildIdentity {
  // Inside THIS package's dist directory exactly — a substring test on
  // any `dist` path component classifies a source checkout that merely
  // lives under some ancestor named dist as compiled output, and then a
  // tsx run reports someone else's sha with advice to rebuild (minjudd
  // and Codex on #121, independently).
  const here = fileURLToPath(import.meta.url);
  const fromDist = here.startsWith(join(packageRoot(), 'dist') + sep);
  if (!fromDist) return liveIdentity();
  try {
    const stamped = JSON.parse(
      readFileSync(join(packageRoot(), 'dist', 'build-info.json'), 'utf8'),
    ) as BuildIdentity;
    if (stamped.commit === undefined) return liveIdentity();
    return resolveIdentity(stamped, liveIdentity());
  } catch {
    return liveIdentity();
  }
}

// A hello against a socket that is already there. Deliberately raw rather
// than through WorkerClient: that spawns a daemon when none is listening,
// and asking a model worker its version is not worth loading a model —
// and it refuses a protocol mismatch, which is the one answer this
// command most needs to be able to print.
function helloIfRunning(
  socketPath: string,
  timeoutMs = 1500,
): Promise<Hello | undefined> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve(undefined);
    const socket = createConnection(socketPath);
    let buffer = '';
    const done = (value: Hello | undefined) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.on('error', () => done(undefined));
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, op: 'hello' }) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        done({
          // Something answered, which is the honest meaning of "running"
          // — but `ok: false` is a refusal, not a hello, and reporting
          // it as a healthy daemon with an unknown version would be the
          // command's own kind of lie (#70 review).
          answered: parsed['ok'] !== false,
          version: typeof parsed['version'] === 'string' ? parsed['version'] : undefined,
          protocol: typeof parsed['protocol'] === 'number' ? parsed['protocol'] : undefined,
          daemon: typeof parsed['daemon'] === 'string' ? parsed['daemon'] : undefined,
        });
      } catch {
        done(undefined);
      }
    });
  });
}

// What is wrong with this daemon, in the order that matters: who it is,
// then whether it answered, then whether it agrees. Identity first
// because the other two are meaningless about a process that is not the
// daemon we think — a worker on audiod's socket used to be reported as a
// stale audiod, with `rebuild the daemon` as the remedy, which is
// instruction rather than description and does not stop being printed
// when someone follows it (#70 review).
//
// Shared rather than written per daemon: the worker loop and audiod had
// drifted to different guards within one commit of each other.
function daemonNote(
  hello: Hello | undefined,
  expected: { name: string; protocol: number; remedy: string },
): string | undefined {
  if (hello === undefined) return undefined;
  if (hello.daemon !== undefined && hello.daemon !== expected.name) {
    return (
      `the process on this socket identifies as ${hello.daemon}, not ${expected.name} — ` +
      `stale socket, or two daemons configured onto one path`
    );
  }
  if (!hello.answered) return 'refused the hello';
  if (hello.protocol !== undefined && hello.protocol !== expected.protocol) {
    return (
      `speaks protocol ${hello.protocol}, this CLI speaks ${expected.protocol} — ${expected.remedy}`
    );
  }
  return undefined;
}

interface Hello {
  answered: boolean;
  version?: string | undefined;
  protocol?: number | undefined;
  daemon?: string | undefined;
}

export async function versionReport(root: string): Promise<VersionReport> {
  const daemons: DaemonReport[] = [];

  const audiod = await helloIfRunning(socketPathFor(root, AUDIOD_SOCKET));
  daemons.push({
    name: AUDIOD_NAME,
    running: audiod !== undefined,
    version: audiod?.version,
    protocol: audiod?.protocol,
    socket: AUDIOD_SOCKET,
    // Against audiod's own number, never the workers'. They are unrelated
    // counters — audiod is at 1 and the workers at 2 — and checking
    // either against the other would invent a disagreement.
    note: daemonNote(audiod, {
      name: AUDIOD_NAME,
      protocol: AUDIOD_PROTOCOL_VERSION,
      remedy: 'rebuild the daemon (pnpm build:native)',
    }),
  });

  // SETUP_SPECS, not a copy: #67 exported it to be the one list, and a
  // worker missing *here* is missing from the command whose entire job is
  // saying which daemons are running — silent about the newest worker,
  // which is the one most likely to be skewed.
  for (const spec of SETUP_SPECS) {
    const hello = await helloIfRunning(socketPathFor(root, spec.socketRelative));

    daemons.push({
      name: spec.name,
      running: hello !== undefined,
      version: hello?.version,
      protocol: hello?.protocol,
      socket: spec.socketRelative,
      note: daemonNote(hello, {
        name: spec.name,
        protocol: WORKER_PROTOCOL_VERSION,
        remedy: 'it predates this build and will refuse to be used',
      }),
    });
  }

  return { cli: { version: packageVersion(), ...buildIdentity() }, workerProtocol: WORKER_PROTOCOL_VERSION, daemons };
}

export function formatVersionReport(report: VersionReport, root: string): string {
  const { cli } = report;
  const lines: string[] = [];
  // Shortened at display alone; the report and the drift comparison
  // carry full shas.
  const short = (sha: string): string => sha.slice(0, 7);
  const build = cli.commit
    ? `${short(cli.commit)}${cli.branch && cli.branch !== 'HEAD' ? ` on ${cli.branch}` : ''}` +
      `${cli.dirtyFiles ? `, ${cli.dirtyFiles} file${cli.dirtyFiles === 1 ? '' : 's'} uncommitted` : ''}` +
      `${cli.checkoutCommit ? `; checkout now at ${short(cli.checkoutCommit)} — pnpm build to update` : ''}` +
      `${
        cli.checkoutDirtyFiles !== undefined
          ? `; checkout has ${cli.checkoutDirtyFiles} uncommitted file${cli.checkoutDirtyFiles === 1 ? '' : 's'} since the build — pnpm build to update`
          : ''
      }`
    : 'not a git checkout';
  lines.push(`field ${cli.version}  (${build})`);
  lines.push(`worker protocol ${report.workerProtocol}`);
  lines.push('');
  const where = relative(process.cwd(), root) || '.';
  lines.push(`daemons in ${where}`);
  for (const d of report.daemons) {
    if (!d.running) {
      lines.push(`  ${d.name.padEnd(13)} not running`);
      continue;
    }
    const proto = d.protocol === undefined ? '' : `  protocol ${d.protocol}`;
    lines.push(`  ${d.name.padEnd(13)} ${(d.version ?? 'unknown').padEnd(8)}${proto}  ${d.socket}`);
    if (d.note) lines.push(`  ${' '.repeat(13)} ! ${d.note}`);
  }
  return lines.join('\n');
}
