import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  ACED_PROTOCOL_VERSION,
  acedErrorResponseSchema,
  acedEventSchema,
  acedGenerateResponseSchema,
  acedHelloResponseSchema,
  acedOkResponseSchema,
  type AceGenerateJob,
  type AcedEvent,
} from './protocol.js';

// Client for the per-project field-aced daemon (ace-generation.md §3):
// daemon-lite like audiod's client, but the daemon is a uv-run Python
// process. The deliberate duplication with audiod/client.ts is small and
// tolerated until a third daemon argues for a shared base.

const SOCKET_RELATIVE = '.field/aced.sock';

function acedProject(): string {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(packageRoot, 'python', 'aced');
}

// FIELD_ACED_PYTHON mirrors FIELD_AUDIOD (ace-generation.md §3.4): an
// interpreter that can import field_aced replaces the uv-managed
// environment — wrappers, alternate venvs, and daemon tests without the
// model environment (PYTHONPATH=python/aced/src is enough).
function daemonCommand(): { command: string; args: string[] } {
  const override = process.env['FIELD_ACED_PYTHON'];
  if (override) {
    // Resolved now because the daemon spawns with its cwd at the project
    // root, where a relative override would no longer mean anything.
    const absolute = resolve(override);
    if (!existsSync(absolute)) {
      throw new Error(`FIELD_ACED_PYTHON points at a missing interpreter: ${override}`);
    }
    return { command: absolute, args: ['-m', 'field_aced', '--socket', SOCKET_RELATIVE] };
  }
  return {
    command: 'uv',
    args: ['run', '--project', acedProject(), 'field-aced', '--socket', SOCKET_RELATIVE],
  };
}

export function acedAvailable(): { ok: boolean; reason?: string } {
  if (!existsSync(join(acedProject(), 'pyproject.toml'))) {
    return { ok: false, reason: 'python/aced missing from the field checkout' };
  }
  return { ok: true };
}

function socketPathFor(root: string): string {
  const absolute = join(root, SOCKET_RELATIVE);
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

export class AcedClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (response: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = '';

  private constructor(
    private readonly socket: Socket,
    readonly daemonVersion: string,
    readonly modelLoaded: boolean,
  ) {
    super();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error('field-aced connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  static async connect(root: string): Promise<AcedClient> {
    const path = socketPathFor(root);
    let socket = await tryConnect(path, 1000);
    if (!socket) {
      const available = acedAvailable();
      if (!available.ok) throw new Error(`field-aced unavailable: ${available.reason}`);
      mkdirSync(join(root, '.field'), { recursive: true });
      const log = openSync(join(root, '.field', 'aced.log'), 'a');
      // uv resolves the environment; --project keeps the daemon's cwd at
      // the project root (the socket path is root-relative — sun_path).
      const { command, args } = daemonCommand();
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
          'field-aced did not start — is uv installed (brew install uv)? See .field/aced.log',
        );
      }
    }

    const probe = new AcedClient(socket, 'unknown', false);
    const hello = await probe.request('hello', {}, acedHelloResponseSchema, 30_000);
    if (hello.protocol !== ACED_PROTOCOL_VERSION) {
      probe.close();
      throw new Error(
        `field-aced speaks protocol ${hello.protocol}, this CLI speaks ${ACED_PROTOCOL_VERSION}`,
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
        const event = acedEventSchema.safeParse(message);
        if (event.success) this.emit('event', event.data satisfies AcedEvent);
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
        reject(new Error(`field-aced ${op}: no response after ${Math.round(timeoutMs / 1000)}s`));
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
    const error = acedErrorResponseSchema.safeParse(raw);
    if (error.success) throw new Error(`aced ${op}: ${error.data.error}`);
    return schema.parse(raw);
  }

  // Generation spans a possible first-run weights download; the timeout is
  // generous and the progress events are the liveness signal.
  generate(job: AceGenerateJob) {
    return this.request('generate', { ...job }, acedGenerateResponseSchema, 3_600_000);
  }

  quit() {
    return this.request('quit', {}, acedOkResponseSchema, 10_000);
  }

  close(): void {
    this.socket.destroy();
  }
}
