import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPathFor as sharedSocketPath } from '../socketPath.js';
import type { z } from 'zod';
import {
  devicesResponseSchema,
  errorResponseSchema,
  eventSchema,
  helloResponseSchema,
  loadResponseSchema,
  okResponseSchema,
  PROTOCOL_VERSION,
  SOCKET_RELATIVE,
  statusResponseSchema,
  type AudiodEvent,
} from './protocol.js';

// Client for the per-project field-audiod daemon (playback.md §3): connects
// to .field/audiod.sock, spawning the daemon on demand when nobody owns the
// socket — daemon-lite lifecycle. The daemon runs with its cwd at the
// project root and a root-relative socket path, keeping the bound path
// inside sun_path's 104 bytes regardless of how deep the project lives.



// The built daemon binary, or undefined if it has not been built. FIELD_AUDIOD
// overrides for wrappers and tests; the default is the CMake output inside
// this package (dist/audiod/client.js → package root → native build dir).
export function daemonBinary(): string | undefined {
  const override = process.env['FIELD_AUDIOD'];
  if (override) {
    // Resolved now because the daemon spawns with its cwd at the project
    // root, where a relative override would no longer mean anything.
    const absolute = resolve(override);
    if (!existsSync(absolute)) {
      throw new Error(`FIELD_AUDIOD points at a missing binary: ${override}`);
    }
    return absolute;
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const built = join(
    packageRoot,
    'native/audiod/build/field-audiod_artefacts/Release/field-audiod',
  );
  return existsSync(built) ? built : undefined;
}

function socketPathFor(root: string): string {
  return sharedSocketPath(root, SOCKET_RELATIVE);
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

export interface ConnectOptions {
  spawnIfNeeded?: boolean;
  nullOutput?: boolean; // spawn flag, for tests
  idleSeconds?: number; // spawn flag
}

export class AudiodClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (response: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = '';

  private constructor(
    private readonly socket: Socket,
    readonly daemonVersion: string,
  ) {
    super();
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => {}); // close handles it; a raw error must not crash the CLI
    socket.on('close', () => {
      // A dead daemon must surface as an error on every in-flight request,
      // never as a silent hang.
      for (const [, entry] of this.pending) {
        entry.reject(new Error('field-audiod connection closed'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  static async connect(root: string, options: ConnectOptions = {}): Promise<AudiodClient> {
    const path = socketPathFor(root);
    let socket = await tryConnect(path, 1000);
    if (!socket) {
      if (!(options.spawnIfNeeded ?? true)) {
        throw new Error('field-audiod is not running');
      }
      const binary = daemonBinary();
      if (!binary) {
        throw new Error('field-audiod is not built (pnpm build:native, or set FIELD_AUDIOD)');
      }
      const args = ['--socket', SOCKET_RELATIVE];
      // FIELD_AUDIOD_NULL covers spawns the caller doesn't parameterize
      // (field play in CI or on a deviceless machine).
      if (options.nullOutput ?? process.env['FIELD_AUDIOD_NULL'] === '1') args.push('--null-output');
      if (options.idleSeconds !== undefined) args.push('--idle', String(options.idleSeconds));
      // .field/ is otherwise created lazily by the build cache; a project
      // that has never built must still be able to spawn the daemon
      // (which also binds its socket in there).
      mkdirSync(join(root, '.field'), { recursive: true });
      // A detached daemon's stderr would otherwise vanish; the log is the
      // only witness when startup fails.
      const log = openSync(join(root, '.field', 'audiod.log'), 'a');
      const child = spawn(binary, args, { cwd: root, detached: true, stdio: ['ignore', 'ignore', log] });
      child.on('error', () => {}); // surfaced as the connect timeout below
      child.unref();
      closeSync(log);
      // The daemon binds before serving; poll rather than racing it. The
      // window is generous because a loaded machine (CI, parallel tests)
      // can be slow to schedule the new process.
      for (let attempt = 0; attempt < 120 && !socket; attempt++) {
        await new Promise((r) => setTimeout(r, 50));
        socket = await tryConnect(path, 250);
      }
      if (!socket) throw new Error('field-audiod did not start (spawned but never answered)');
    }

    const client = new AudiodClient(socket, 'unknown');
    const hello = await client.request('hello', {}, helloResponseSchema);
    if (hello.protocol !== PROTOCOL_VERSION) {
      client.close();
      throw new Error(
        `field-audiod speaks protocol ${hello.protocol}, this CLI speaks ${PROTOCOL_VERSION} — rebuild the daemon`,
      );
    }
    (client as { daemonVersion: string }).daemonVersion = hello.version;
    return client;
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
        continue; // a malformed daemon line must not crash the CLI
      }
      if (typeof message['id'] === 'number') {
        const entry = this.pending.get(message['id']);
        if (entry) {
          this.pending.delete(message['id']);
          entry.resolve(message);
        }
      } else if (typeof message['event'] === 'string') {
        const event = eventSchema.safeParse(message);
        if (event.success) this.emit('event', event.data satisfies AudiodEvent);
      }
    }
  }

  async request<T>(
    op: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const id = this.nextId++;
    const raw = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, op, ...params }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    const error = errorResponseSchema.safeParse(raw);
    if (error.success) throw new Error(`audiod ${op}: ${error.data.error}`);
    return schema.parse(raw);
  }

  devices() {
    return this.request('devices', {}, devicesResponseSchema);
  }
  selectDevice(name: string) {
    return this.request('device.select', { name }, okResponseSchema);
  }
  load(path: string, loop = false) {
    // The flag is only sent when set: an older daemon would silently
    // ignore it, so callers version-guard before asking (play.ts).
    return this.request('load', loop ? { path, loop: true } : { path }, loadResponseSchema);
  }
  reload(path: string) {
    // Queues a takeover of the looping stream at the next wrap
    // (watch.md §1.1). Daemon >= 0.4; callers version-guard like load's
    // loop flag — an older daemon answers "unknown op".
    return this.request('reload', { path }, loadResponseSchema);
  }
  play() {
    return this.request('play', {}, okResponseSchema);
  }
  pause() {
    return this.request('pause', {}, okResponseSchema);
  }
  stop() {
    return this.request('stop', {}, okResponseSchema);
  }
  locate(sample: number) {
    return this.request('locate', { sample }, okResponseSchema);
  }
  status() {
    return this.request('status', {}, statusResponseSchema);
  }
  quit() {
    return this.request('quit', {}, okResponseSchema);
  }

  close(): void {
    this.socket.destroy();
  }
}
