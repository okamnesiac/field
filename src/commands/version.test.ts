import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatVersionReport, versionReport, resolveIdentity } from './version.js';
import { WORKER_PROTOCOL_VERSION } from '../workers/protocol.js';
import { SETUP_SPECS } from './generate.js';
import {
  DAEMON_NAME as AUDIOD_NAME,
  PROTOCOL_VERSION as AUDIOD_PROTOCOL_VERSION,
  SOCKET_RELATIVE as AUDIOD_SOCKET,
} from '../audiod/protocol.js';

// `field --version` answers two questions, and the second is the one that
// bites: which build is each *daemon* running. A daemon outlives the CLI
// that spawned it by design, so the process answering can predate the
// code asking — which is how `--exaggeration` reached a worker that
// silently dropped it.

let root: string;
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-version-'));
  mkdirSync(join(root, '.field'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  rmSync(root, { recursive: true, force: true });
});

// A daemon that answers `hello` and nothing else, which is all this
// command asks of one.
function fakeDaemon(socketRelative: string, hello: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', () =>
        socket.write(JSON.stringify({ id: 1, ok: true, ...hello }) + '\n'),
      );
    });
    servers.push(server);
    server.listen(join(root, socketRelative), () => resolve());
  });
}

describe('field --version', () => {
  it('reports a build identity, not just a release number', async () => {
    // "0.1.0" is true of every build this project has ever produced. The
    // commit is what distinguishes the one running from the one that was
    // running twenty minutes ago, which is the actual question.
    const report = await versionReport(root);
    expect(report.cli.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.cli.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(report.workerProtocol).toBe(WORKER_PROTOCOL_VERSION);
  });

  it('says which daemons are not running rather than starting them', async () => {
    // Asking a model worker its version is not worth loading a model, so
    // this path must never spawn. Nothing is listening here and the
    // report still returns — a spawn would hang or download weights.
    const report = await versionReport(root);
    // Sourced from the canonical list rather than typed out, so adding a
    // worker breaks this loudly instead of leaving the report quietly
    // short by one (#70 review).
    expect(report.daemons.map((d) => d.name)).toEqual([
      AUDIOD_NAME,
      ...SETUP_SPECS.map((s) => s.name),
    ]);
    expect(report.daemons.every((d) => !d.running)).toBe(true);
    expect(formatVersionReport(report, root)).toContain('field-voiced  not running');
  });

  it('reports what a running daemon says about itself', async () => {
    await fakeDaemon('.field/voiced.sock', {
      protocol: WORKER_PROTOCOL_VERSION,
      daemon: 'field-voiced',
      version: '9.9.9',
      model_loaded: false,
    });
    const voiced = (await versionReport(root)).daemons.find((d) => d.name === 'field-voiced')!;
    expect(voiced.running).toBe(true);
    // Reported, not assumed: a daemon's own answer is the only evidence
    // of what code it loaded, and 9.9.9 is nothing this repo declares.
    expect(voiced.version).toBe('9.9.9');
    expect(voiced.note).toBeUndefined();
  });

  it('flags a daemon whose protocol predates this build', async () => {
    // The reason the command exists. A worker started before a protocol
    // change answers hello perfectly well and will then refuse — or,
    // before the bump that made this visible, quietly do the wrong
    // thing. Saying so here turns a puzzle into a line of output.
    await fakeDaemon('.field/voiced.sock', {
      protocol: WORKER_PROTOCOL_VERSION - 1,
      daemon: 'field-voiced',
      version: '0.1.0',
      model_loaded: false,
    });
    const report = await versionReport(root);
    const voiced = report.daemons.find((d) => d.name === 'field-voiced')!;
    expect(voiced.protocol).toBe(WORKER_PROTOCOL_VERSION - 1);
    expect(voiced.note).toContain('predates this build');
    expect(formatVersionReport(report, root)).toContain('!');
  });

  it('flags a stale audiod against audiod\'s own number, not the workers\'', async () => {
    // audiod is at protocol 1 and the workers at 2; comparing either
    // against the other invents a disagreement. Skipping audiod was the
    // alternative and worse: AudiodClient refuses a mismatch and
    // `--watch` gates on the version, so a stale audiod is an enforced
    // failure that used to print here as a clean line (#70 review).
    await fakeDaemon(AUDIOD_SOCKET, {
      protocol: AUDIOD_PROTOCOL_VERSION + 1,
      daemon: AUDIOD_NAME,
      version: '9.9.9',
    });
    const audiod = (await versionReport(root)).daemons.find((d) => d.name === AUDIOD_NAME)!;
    expect(audiod.note).toContain('rebuild the daemon');
  });

  it('does not flag a current audiod merely for differing from the workers', async () => {
    // The invented-disagreement case: audiod at its own current protocol
    // is fine even though that number is not the workers'.
    await fakeDaemon(AUDIOD_SOCKET, {
      protocol: AUDIOD_PROTOCOL_VERSION,
      daemon: AUDIOD_NAME,
      version: '0.4.0',
    });
    const audiod = (await versionReport(root)).daemons.find((d) => d.name === AUDIOD_NAME)!;
    expect(AUDIOD_PROTOCOL_VERSION).not.toBe(WORKER_PROTOCOL_VERSION); // the trap is real
    expect(audiod.note).toBeUndefined();
  });

  it('does not hand audiod a remedy for a process that is not audiod', async () => {
    // The interaction, not the gap: put a worker on audiod's socket and
    // the old code reported field-audiod at the worker's version, then
    // measured the worker's protocol 2 against audiod's 1 and printed
    // "rebuild the daemon (pnpm build:native)". Every part wrong, and
    // instruction rather than description — someone rebuilds, nothing
    // changes, and the report keeps saying it (#70 review).
    await fakeDaemon(AUDIOD_SOCKET, {
      protocol: WORKER_PROTOCOL_VERSION,
      daemon: 'field-voiced',
      version: '0.1.0',
    });
    const audiod = (await versionReport(root)).daemons.find((d) => d.name === AUDIOD_NAME)!;
    expect(audiod.note).toContain('identifies as field-voiced');
    expect(audiod.note).not.toContain('rebuild the daemon');
  });

  it('does not report an audiod refusal as a healthy audiod', async () => {
    await fakeDaemon(AUDIOD_SOCKET, { ok: false, error: 'unknown op' });
    const audiod = (await versionReport(root)).daemons.find((d) => d.name === AUDIOD_NAME)!;
    expect(audiod.note).toContain('refused the hello');
  });

  it('says when the wrong worker is on a socket', async () => {
    // One socket convention across every worker means a stale or
    // mis-pointed socket puts one worker's process under another's name.
    // A version report that mislabels a process is worse than one that
    // says nothing (#70 review).
    await fakeDaemon('.field/voiced.sock', {
      protocol: WORKER_PROTOCOL_VERSION,
      daemon: 'field-aced',
      version: '0.1.0',
    });
    const voiced = (await versionReport(root)).daemons.find((d) => d.name === 'field-voiced')!;
    expect(voiced.note).toContain('identifies as field-aced');
  });

  it('does not report a refusal as a healthy daemon', async () => {
    // `ok: false` is a refusal, not a hello. Reporting it as running with
    // an unknown version is the command's own kind of lie.
    await fakeDaemon('.field/voiced.sock', { ok: false, error: 'unknown op' });
    const voiced = (await versionReport(root)).daemons.find((d) => d.name === 'field-voiced')!;
    expect(voiced.note).toContain('refused the hello');
  });

  it('does not flag a daemon that agrees', async () => {
    // The negative half: a warning that fires on a current daemon is a
    // warning nobody reads.
    await fakeDaemon('.field/aced.sock', {
      protocol: WORKER_PROTOCOL_VERSION,
      daemon: 'field-aced',
      version: '0.1.0',
      model_loaded: false,
    });
    const report = await versionReport(root);
    expect(report.daemons.find((d) => d.name === 'field-aced')!.note).toBeUndefined();
    expect(formatVersionReport(report, root)).not.toContain('!');
  });
});

describe('resolveIdentity', () => {
  // The artifact's baked identity wins, and drift from the checkout is
  // surfaced rather than silently replaced — --version reported the
  // checkout's branch while the installed dist ran another build, and
  // the confusion cost a debugging round (2026-08-09).
  it('reports the baked identity, noting a drifted checkout', () => {
    const resolved = resolveIdentity(
      { commit: 'aaaa111', branch: 'feature/x', dirtyFiles: 0 },
      { commit: 'bbbb222', branch: 'main', dirtyFiles: 3 },
    );
    expect(resolved.commit).toBe('aaaa111');
    expect(resolved.branch).toBe('feature/x');
    expect(resolved.checkoutCommit).toBe('bbbb222');
  });

  it('stays quiet when build and checkout agree', () => {
    const resolved = resolveIdentity(
      { commit: 'aaaa111', branch: 'main' },
      { commit: 'aaaa111', branch: 'main' },
    );
    expect(resolved.checkoutCommit).toBeUndefined();
  });
});

describe('formatVersionReport with a drifted checkout', () => {
  it('names both shas and the command that reconciles them', () => {
    const text = formatVersionReport(
      {
        cli: { version: '0.1.0', commit: 'aaaa111', branch: 'feature/x', checkoutCommit: 'bbbb222' },
        workerProtocol: 2,
        daemons: [],
      },
      process.cwd(),
    );
    expect(text).toContain('aaaa111 on feature/x; checkout now at bbbb222 — pnpm build to update');
  });
});
