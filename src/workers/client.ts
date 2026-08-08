import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  WORKER_PROTOCOL_VERSION,
  workerErrorResponseSchema,
  workerEventSchema,
  workerGenerateResponseSchema,
  workerHelloResponseSchema,
  workerOkResponseSchema,
  type WorkerEvent,
  type WorkerSpec,
} from './protocol.js';

// One client for every generation worker: spawn on demand, connect,
// handshake, correlate requests by id, forward progress events.
//
// This was `src/aced/client.ts`, which said its duplication with
// audiod/client.ts was "tolerated until a third daemon argues for a
// shared base". field-voiced is that third daemon, so the trigger the
// codebase wrote down is what moved this rather than a preference —
// the same argument that moved the Python lifecycle in #59.
//
// audiod's client stays where it is. It spawns a C++ binary rather than a
// uv project, and its vocabulary is transport rather than generation; the
// framing is all it shares, and sharing framing alone would leave both
// sides more tangled than either is now. What is shared here is a whole
// interaction, not a coincidence of syntax.

function packageRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function workerProject(spec: WorkerSpec): string {
  return join(packageRootDir(), 'python', spec.packageDir);
}

// The override mirrors FIELD_AUDIOD (ace-generation.md §3.4): an
// interpreter that can import the worker replaces the uv-managed
// environment — wrappers, alternate venvs, and daemon tests without the
// model environment (PYTHONPATH=python/worker/src:python/<pkg>/src is
// enough — the lifecycle package plus the worker's own).
export function workerLaunchCommand(spec: WorkerSpec): { command: string; args: string[] } {
  const override = process.env[spec.pythonOverrideEnv];
  if (override) {
    // Resolved now because the daemon spawns with its cwd at the project
    // root, where a relative override would no longer mean anything.
    const absolute = resolve(override);
    if (!existsSync(absolute)) {
      throw new Error(`${spec.pythonOverrideEnv} points at a missing interpreter: ${override}`);
    }
    return { command: absolute, args: ['-m', spec.module, '--socket', spec.socketRelative] };
  }
  // --no-sync is what makes `field setup` a gate rather than a label.
  // uv run's default is to sync the project environment first, so without
  // it the first `field generate` quietly installs torch and friends —
  // and "explicit, never automatic" (ace-generation.md §3.4) described
  // the intent rather than the behaviour (#61 review). With it, an
  // unsynced environment fails fast and connectTo says which command
  // fixes it.
  return {
    command: 'uv',
    args: [
      'run',
      '--no-sync',
      '--project',
      workerProject(spec),
      spec.script,
      '--socket',
      spec.socketRelative,
    ],
  };
}

// Is the worker's source here at all — the question `field setup` asks,
// since setup is what creates the environment the next function wants.
export function workerPackagePresent(spec: WorkerSpec): { ok: boolean; reason?: string } {
  if (!existsSync(join(workerProject(spec), 'pyproject.toml'))) {
    return { ok: false, reason: `python/${spec.packageDir} missing from the field checkout` };
  }
  return { ok: true };
}

// What can be learned about a worker's environment without launching it.
export interface EnvironmentProbe {
  uvPresent: boolean;
  // `.venv/bin/<script>` — the console script `uv run` spawns, which
  // exists only once uv has installed the project itself. A directory
  // called `.venv` proves nothing: `uv sync --only-group dev` builds one
  // with pyright in it and no worker, which is what CI builds for the
  // pyright gate and what a dev checkout therefore has (#61 review).
  scriptInstalled: boolean;
  // `uv sync --check`: installed is not the same as current. undefined
  // when uv is absent and the question cannot be asked.
  synced: boolean | undefined;
}

// Pure so it can be exercised for every combination, on any machine,
// whatever happens to be installed on it. Deciding from ambient state
// instead would make these assertions pass or fail by accident of the
// checkout — which is how the two defects before this one survived: a
// dev-only `.venv` reading as installed, and every combination of the
// three facts below being tested while the code producing them was
// downloading a Python interpreter.
export function environmentVerdict(
  spec: WorkerSpec,
  probe: EnvironmentProbe,
): { ok: boolean; reason?: string } {
  const setup =
    `run \`field setup ${spec.packageDir}\` ` +
    `(setup is explicit and never automatic: ace-generation.md §3.4)`;
  // uv first: it is the launcher *and* what setup runs, so telling
  // someone to run setup when uv is missing is advice that cannot work.
  if (!probe.uvPresent) {
    return { ok: false, reason: 'uv is not installed (brew install uv)' };
  }
  if (!probe.scriptInstalled) {
    return { ok: false, reason: `its environment is not installed — ${setup}` };
  }
  if (probe.synced === false) {
    return { ok: false, reason: `its environment is out of date — ${setup}` };
  }
  if (probe.synced === undefined) {
    // Unreachable by construction — the probe runs the check exactly when
    // uv is present and the worker is installed, which is exactly here.
    // Fail closed anyway: if the two ever disagree about when the check
    // runs, the wrong answer must be a refusal rather than a launch.
    return { ok: false, reason: `its environment could not be verified — ${setup}` };
  }
  return { ok: true };
}

// Its own function because it is the fact that was wrong: the gate used
// to ask whether `.venv` existed, which a dev-only sync satisfies without
// installing any worker. Verified against uv rather than assumed — a full
// sync of a project with a `[project.scripts]` entry writes it, and
// `--only-group dev` does not.
export function workerScriptInstalled(spec: WorkerSpec): boolean {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  return existsSync(join(workerProject(spec), '.venv', binDir, spec.script));
}

// How the probe runs a command. Injectable so a test can assert on the
// commands themselves rather than on the booleans they produce — the
// booleans were fully covered while the probe was quietly installing a
// Python interpreter, and no assertion about a return value could have
// noticed (#61 review).
export interface ProbeRun {
  (command: string, args: string[]): { status: number | null; error?: Error | undefined };
}

function spawnProbe(command: string, args: string[]): ReturnType<ProbeRun> {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return { status: result.status, error: result.error };
}

// Everything uv is asked here has to be free of side effects, because
// this runs on the way to refusing — the whole point is that nothing gets
// installed without `field setup`.
//
//   --version    asks whether uv exists without naming a project, so it
//                cannot resolve, download or build anything.
//   --check      reports whether the environment matches the lockfile and
//                will not modify it ("Would replace project environment").
//   --locked     asserts uv.lock will not change, so a lockfile that has
//                fallen behind pyproject is an error rather than
//                something to rewrite. This was `--frozen`, which only
//                means "sync without updating the lock" — permission to
//                proceed on a stale one, not a check (#61 follow-up
//                review). Both keep the probe from writing to the repo;
//                only this one also notices that the answer is stale.
//   --no-python-downloads
//                uv installs a compatible CPython when it cannot find
//                one — a 24 MB download, completed, not attempted. So on
//                a fresh machine the gate against automatic installation
//                was itself an automatic installation (#61 review).
const PROBE_CHECK_ARGS = ['sync', '--check', '--locked', '--no-python-downloads', '--project'];

export function probeEnvironment(spec: WorkerSpec, run: ProbeRun = spawnProbe): EnvironmentProbe {
  const version = run('uv', ['--version']);
  const uvPresent = !version.error && version.status === 0;
  const scriptInstalled = workerScriptInstalled(spec);
  // Short-circuit: with uv missing or the worker not installed the
  // verdict is already decided, so asking uv anything is a subprocess
  // whose answer nobody reads — and, before this, a subprocess that
  // could install an interpreter on the way to saying "not installed".
  if (!uvPresent || !scriptInstalled) return { uvPresent, scriptInstalled, synced: undefined };
  const check = run('uv', [...PROBE_CHECK_ARGS, workerProject(spec)]);
  return { uvPresent, scriptInstalled, synced: check.status === 0 };
}

// Can this worker be started right now — the question `connectTo` asks.
// Since --no-sync means the daemon will not install anything, an unusable
// environment is a diagnosis to make here rather than a spawn that fails
// silently into a log and surfaces sixty seconds later as a connect
// timeout (#61 review). An interpreter override supplies its own
// environment, so it skips this the way it skips uv — and skips the
// subprocess with it, which is what keeps the stub tests fast.
export function workerAvailable(spec: WorkerSpec): { ok: boolean; reason?: string } {
  const present = workerPackagePresent(spec);
  if (!present.ok) return present;
  if (process.env[spec.pythonOverrideEnv]) return { ok: true };
  return environmentVerdict(spec, probeEnvironment(spec));
}

function socketPathFor(root: string, spec: WorkerSpec): string {
  const absolute = join(root, spec.socketRelative);
  const rel = relative(process.cwd(), absolute);
  return rel.length < absolute.length ? rel : absolute;
}

function tryConnect(path: string, timeoutMs: number): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(undefined);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

export class WorkerClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (response: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = '';

  // Public rather than protected so `connectTo` can build the *subclass*
  // it was handed. Casting the base instance to the subclass instead
  // typechecks and then fails at runtime with "generate is not a
  // function" — which the live aced tests caught on the first run.
  constructor(
    private readonly spec: WorkerSpec,
    private readonly socket: Socket,
    readonly daemonVersion: string,
    readonly modelLoaded: boolean,
  ) {
    super();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`${spec.name} connection closed`));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  static async connectTo<T extends WorkerClient>(
    root: string,
    spec: WorkerSpec,
    make: new (
      spec: WorkerSpec,
      socket: Socket,
      daemonVersion: string,
      modelLoaded: boolean,
    ) => T,
  ): Promise<T> {
    const path = socketPathFor(root, spec);
    let socket = await tryConnect(path, 1000);
    if (!socket) {
      const available = workerAvailable(spec);
      if (!available.ok) throw new Error(`${spec.name} unavailable: ${available.reason}`);
      mkdirSync(join(root, '.field'), { recursive: true });
      const log = openSync(join(root, spec.logRelative), 'a');
      // --project points uv at the worker's environment without moving
      // the daemon's cwd off the field project root (the socket path is
      // root-relative — sun_path). It resolves nothing: --no-sync means
      // an environment `field setup` has not built is an error, which
      // workerAvailable has already diagnosed above.
      const { command, args } = workerLaunchCommand(spec);
      const child = spawn(command, args, {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'ignore', log],
      });
      child.on('error', () => {}); // surfaced as the connect timeout below
      child.unref();
      closeSync(log);
      // Patient anyway: the environment is already installed, but a cold
      // interpreter with torch on the path is not instant.
      for (let attempt = 0; attempt < 240 && !socket; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        socket = await tryConnect(path, 250);
      }
      if (!socket) {
        throw new Error(
          `${spec.name} did not start — run \`field setup ${spec.packageDir}\` to install its ` +
            `environment (and check uv is installed: brew install uv). See ${spec.logRelative}`,
        );
      }
    }

    const probe = new make(spec, socket, 'unknown', false);
    const hello = await probe.request('hello', {}, workerHelloResponseSchema, 30_000);
    // Who answered, not just what it speaks. Every worker now shares one
    // protocol and one socket convention, so a stale or misconfigured
    // socket lets one worker's daemon satisfy another's client — a voice
    // job reaching field-aced would be rejected as a malformed ACE job at
    // best, and the handshake is where that should be caught rather than
    // three seconds later in a confusing error (#60 review).
    if (hello.daemon !== spec.name) {
      probe.close();
      throw new Error(
        `${spec.name}: the daemon at ${path} identifies as ${hello.daemon} — ` +
          `stale socket, or two workers configured onto one path`,
      );
    }
    if (hello.protocol !== WORKER_PROTOCOL_VERSION) {
      probe.close();
      // Actionable, following the `field-audiod ... predates --watch`
      // precedent in cli.ts: a version mismatch on a daemon the CLI
      // spawns is almost always a *running* one that predates the
      // build, and knowing that is the difference between a puzzle and
      // a fix. It idle-exits on its own; saying so beats leaving
      // someone to discover it.
      throw new Error(
        `${spec.name} speaks protocol ${hello.protocol}, this CLI speaks ` +
          `${WORKER_PROTOCOL_VERSION} — the running daemon predates this build. ` +
          `It exits when idle, or stop it and retry (it respawns): ` +
          // `spec.script`, not `spec.module`: the uv branch launches the
          // `[project.scripts]` entry point (`field-voiced`), and only the
          // interpreter override — which exists for the daemon tests —
          // launches `-m field_voiced`. Anyone reading this has run
          // `field setup` and has no override, so a module-shaped pattern
          // matches nothing. pkill is silent when it matches nothing, so
          // the remedy would appear to work and change nothing (#69
          // review).
          `pkill -f '${spec.script} --socket'`,
      );
    }
    (probe as { daemonVersion: string }).daemonVersion = hello.version;
    (probe as { modelLoaded: boolean }).modelLoaded = hello.model_loaded;
    return probe;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message['id'] === 'number') {
        const entry = this.pending.get(message['id']);
        if (entry) {
          this.pending.delete(message['id']);
          entry.resolve(message);
        }
      } else if (typeof message['event'] === 'string') {
        const event = workerEventSchema.safeParse(message);
        if (event.success) this.emit('event', event.data satisfies WorkerEvent);
      }
    }
  }

  async request<T>(
    op: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const id = this.nextId++;
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`${this.spec.name} ${op}: no response after ${Math.round(timeoutMs / 1000)}s`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.write(JSON.stringify({ id, op, ...params }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    const error = workerErrorResponseSchema.safeParse(raw);
    if (error.success) throw new Error(`${this.spec.name} ${op}: ${error.data.error}`);
    return schema.parse(raw);
  }

  // Generation spans a possible first-run weights download; the timeout is
  // generous and the progress events are the liveness signal.
  //
  // Protected, with each worker exposing its own typed `generate`: a base
  // method taking `Record<string, unknown>` and a subclass narrowing it
  // is unsound, and TypeScript says so. The job shape is the one thing
  // that genuinely differs between workers, so it is the one thing they
  // each declare.
  protected requestGenerate(job: Record<string, unknown>) {
    return this.request('generate', { ...job }, workerGenerateResponseSchema, 3_600_000);
  }

  quit() {
    return this.request('quit', {}, workerOkResponseSchema, 10_000);
  }

  close(): void {
    this.socket.destroy();
  }
}
