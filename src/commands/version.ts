import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACED_SPEC } from '../aced/client.js';
import { VOICED_SPEC } from '../voiced/client.js';
import { WORKER_PROTOCOL_VERSION, type WorkerSpec } from '../workers/protocol.js';

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

// The version the package declares, read rather than restated. cli.ts
// carried its own copy of the literal, which is one edit away from a
// `field --version` that disagrees with the package it came from.
function declaredVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
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
): Promise<{ version?: string | undefined; protocol?: number | undefined } | undefined> {
  return new Promise((resolve) => {
    if (!existsSync(socketPath)) return resolve(undefined);
    const socket = createConnection(socketPath);
    let buffer = '';
    const done = (
      value: { version?: string | undefined; protocol?: number | undefined } | undefined,
    ) => {
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
          version: typeof parsed['version'] === 'string' ? parsed['version'] : undefined,
          protocol: typeof parsed['protocol'] === 'number' ? parsed['protocol'] : undefined,
        });
      } catch {
        done(undefined);
      }
    });
  });
}

const AUDIOD_SOCKET = '.field/audiod.sock';

export async function versionReport(root: string): Promise<VersionReport> {
  const daemons: DaemonReport[] = [];

  const audiod = await helloIfRunning(join(root, AUDIOD_SOCKET));
  daemons.push({
    name: 'field-audiod',
    running: audiod !== undefined,
    version: audiod?.version,
    protocol: audiod?.protocol,
    socket: AUDIOD_SOCKET,
  });

  for (const spec of [ACED_SPEC, VOICED_SPEC] satisfies WorkerSpec[]) {
    const hello = await helloIfRunning(join(root, spec.socketRelative));
    const skewed =
      hello?.protocol !== undefined && hello.protocol !== WORKER_PROTOCOL_VERSION
        ? `speaks protocol ${hello.protocol}, this CLI speaks ${WORKER_PROTOCOL_VERSION} — ` +
          `it predates this build and will refuse to be used`
        : undefined;
    daemons.push({
      name: spec.name,
      running: hello !== undefined,
      version: hello?.version,
      protocol: hello?.protocol,
      socket: spec.socketRelative,
      note: skewed,
    });
  }

  return { cli: { version: declaredVersion(), ...buildIdentity() }, workerProtocol: WORKER_PROTOCOL_VERSION, daemons };
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
