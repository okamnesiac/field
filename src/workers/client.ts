import { spawn } from 'node:child_process';
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
function daemonCommand(spec: WorkerSpec): { command: string; args: string[] } {
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
  return {
    command: 'uv',
    args: ['run', '--project', workerProject(spec), spec.script, '--socket', spec.socketRelative],
  };
}

export function workerAvailable(spec: WorkerSpec): { ok: boolean; reason?: string } {
  if (!existsSync(join(workerProject(spec), 'pyproject.toml'))) {
    return { ok: false, reason: `python/${spec.packageDir} missing from the field checkout` };
  }
  return { ok: true };
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
      // uv resolves the environment; --project keeps the daemon's cwd at
      // the project root (the socket path is root-relative — sun_path).
      const { command, args } = daemonCommand(spec);
      const child = spawn(command, args, {
        cwd: root,
        detached: true,
        stdio: ['ignore', 'ignore', log],
      });
      child.on('error', () => {}); // surfaced as the connect timeout below
      child.unref();
      closeSync(log);
      // First spawn may resolve the uv environment; be patient.
      for (let attempt = 0; attempt < 240 && !socket; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        socket = await tryConnect(path, 250);
      }
      if (!socket) {
        throw new Error(
          `${spec.name} did not start — is uv installed (brew install uv)? ` +
            `See ${spec.logRelative}`,
        );
      }
    }

    const probe = new make(spec, socket, 'unknown', false);
    const hello = await probe.request('hello', {}, workerHelloResponseSchema, 30_000);
    if (hello.protocol !== WORKER_PROTOCOL_VERSION) {
      probe.close();
      throw new Error(
        `${spec.name} speaks protocol ${hello.protocol}, this CLI speaks ${WORKER_PROTOCOL_VERSION}`,
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
