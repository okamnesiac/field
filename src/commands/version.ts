import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from '../packageVersion.js';
import { socketPathFor } from '../socketPath.js';
import { PROTOCOL_VERSION as AUDIOD_PROTOCOL_VERSION } from '../audiod/protocol.js';
import { SETUP_SPECS } from './generate.js';
import { WORKER_PROTOCOL_VERSION } from '../workers/protocol.js';

// `field version`: which build is running, and which build each daemon is
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
function buildIdentity(): {
  commit?: string | undefined;
  branch?: string | undefined;
  dirtyFiles?: number | undefined;
} {
  const git = (args: string[]): string | undefined => {
    const r = spawnSync('git', ['-C', packageRoot(), ...args], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  const commit = git(['rev-parse', '--short', 'HEAD']);
  if (commit === undefined) return {};
  const status = git(['status', '--porcelain']);
  return {
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyFiles: status === undefined ? undefined : status.split('\n').filter((l) => l.trim()).length,
  };
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

interface Hello {
  answered: boolean;
  version?: string | undefined;
  protocol?: number | undefined;
  daemon?: string | undefined;
}

const AUDIOD_SOCKET = '.field/audiod.sock';

export async function versionReport(root: string): Promise<VersionReport> {
  const daemons: DaemonReport[] = [];

  const audiod = await helloIfRunning(socketPathFor(root, AUDIOD_SOCKET));
  daemons.push({
    name: 'field-audiod',
    running: audiod !== undefined,
    version: audiod?.version,
    protocol: audiod?.protocol,
    socket: AUDIOD_SOCKET,
    // Compared against audiod's own number, never the workers'. They are
    // unrelated counters — audiod is at 1 and the workers at 2 — and
    // checking either against the other would invent a disagreement.
    // Skipping audiod entirely was the alternative and the worse one:
    // AudiodClient refuses a mismatch and `--watch` gates on the version
    // separately, so a stale audiod is a real, enforced failure that
    // printed here as a clean line (#70 review).
    note:
      audiod?.protocol !== undefined && audiod.protocol !== AUDIOD_PROTOCOL_VERSION
        ? `speaks protocol ${audiod.protocol}, this CLI speaks ${AUDIOD_PROTOCOL_VERSION} — ` +
          `rebuild the daemon (pnpm build:native)`
        : undefined,
  });

  // SETUP_SPECS, not a copy: #67 exported it to be the one list, and a
  // worker missing *here* is missing from the command whose entire job is
  // saying which daemons are running — silent about the newest worker,
  // which is the one most likely to be skewed.
  for (const spec of SETUP_SPECS) {
    const hello = await helloIfRunning(socketPathFor(root, spec.socketRelative));
    // Who answered, before what it said about itself. One socket
    // convention across every worker means a stale or mis-pointed socket
    // puts one worker's process under another's name — and a version
    // report that mislabels the process is worse than one that says
    // nothing (#70 review; the same check connectTo makes in #60).
    const wrongDaemon =
      hello?.daemon !== undefined && hello.daemon !== spec.name
        ? `the process on this socket identifies as ${hello.daemon}, not ${spec.name} — ` +
          `stale socket, or two workers configured onto one path`
        : undefined;
    const skewed =
      hello?.protocol !== undefined && hello.protocol !== WORKER_PROTOCOL_VERSION
        ? `speaks protocol ${hello.protocol}, this CLI speaks ${WORKER_PROTOCOL_VERSION} — ` +
          `it predates this build and will refuse to be used`
        : undefined;
    const silent = hello !== undefined && !hello.answered ? 'refused the hello' : undefined;
    daemons.push({
      name: spec.name,
      running: hello !== undefined,
      version: hello?.version,
      protocol: hello?.protocol,
      socket: spec.socketRelative,
      note: wrongDaemon ?? silent ?? skewed,
    });
  }

  return { cli: { version: packageVersion(), ...buildIdentity() }, workerProtocol: WORKER_PROTOCOL_VERSION, daemons };
}

export function formatVersionReport(report: VersionReport, root: string): string {
  const { cli } = report;
  const lines: string[] = [];
  const build = cli.commit
    ? `${cli.commit}${cli.branch && cli.branch !== 'HEAD' ? ` on ${cli.branch}` : ''}` +
      `${cli.dirtyFiles ? `, ${cli.dirtyFiles} file${cli.dirtyFiles === 1 ? '' : 's'} uncommitted` : ''}`
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
