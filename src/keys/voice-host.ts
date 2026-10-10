import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { programPath, sclangCommand } from '../generators/supercollider.js';

export function voiceHostScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sc', 'voice-host.scd');
}

// An instrument name resolves exactly as a supercollider: entry's source
// does, after `.scd` is added to a name without an extension
// (keyboard-instrument.md §2.1).
export function instrumentPath(spec: string, root: string): string {
  const source = extname(spec) === '' ? `${spec}.scd` : spec;
  const relative = programPath({ source });
  return isAbsolute(relative) ? relative : resolve(root, relative);
}

// Field chooses scsynth's port so that it can send /quit itself, even
// after sclang has died (§2.6).
export function freeUdpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(() => resolvePort(port));
    });
  });
}

// An OSC message with an address and no arguments: the address, then the
// type tag string ",", each NUL-terminated and padded to four bytes.
export function oscMessage(address: string): Buffer {
  const pad = (text: string): Buffer => {
    const bytes = Buffer.from(`${text}\0`, 'ascii');
    return Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  };
  return Buffer.concat([pad(address), pad(',')]);
}

function sendQuit(port: number): Promise<void> {
  return new Promise((done) => {
    const socket = createSocket('udp4');
    socket.send(oscMessage('/quit'), port, '127.0.0.1', () => socket.close(() => done()));
  });
}

const hostLine = z.union([
  z.object({ ready: z.literal(true), device: z.string(), sample_rate: z.number() }),
  z.object({ restarting: z.literal(true) }),
  z.object({ error: z.string() }),
  z.object({ voice_on: z.number() }),
  z.object({ voice_off: z.number() }),
]);

export type VoiceHostStatus =
  | { state: 'live'; device: string; sampleRate: number }
  | { state: 'restarting' }
  | { state: 'voice'; note: number; on: boolean };

export function parseHostLine(line: string): z.infer<typeof hostLine> | undefined {
  if (!line.startsWith('@field ')) return undefined;
  try {
    return hostLine.parse(JSON.parse(line.slice('@field '.length)));
  } catch {
    return undefined;
  }
}

export interface VoiceHostOptions {
  instrument: string;
  device?: string;
  onStatus?: (status: VoiceHostStatus) => void;
  // Called when the host exits on its own after it was ready.
  onExit?: (reason: string) => void;
  trace?: boolean;
  env?: NodeJS.ProcessEnv;
}

const OUTPUT_TAIL = 15;

export class VoiceHost {
  private closing = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly port: number,
  ) {}

  static async start(options: VoiceHostOptions): Promise<VoiceHost> {
    const env = options.env ?? process.env;
    const port = await freeUdpPort();
    const child = spawn(sclangCommand(env), ['-D', voiceHostScript()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...env,
        FIELD_MODE: 'voice',
        FIELD_INSTRUMENT: options.instrument,
        FIELD_SC_PORT: String(port),
        FIELD_PARENT_PID: String(process.pid),
        ...(options.device !== undefined ? { FIELD_DEVICE: options.device } : {}),
        ...(options.trace === true ? { FIELD_VOICE_TRACE: '1' } : {}),
      },
    });
    const host = new VoiceHost(child, port);
    // sclang reports compile and runtime errors on stdout, so the tail of
    // it is what explains a host that never became ready.
    const tail: string[] = [];

    return new Promise((resolveHost, reject) => {
      let ready = false;
      let lastError: string | undefined;
      const why = (code: number | null): string => {
        // What sclang printed before its banner is the class library
        // compiling, which explains nothing about this instrument.
        const banner = tail.findLastIndex((l) => l.includes('*** Welcome to SuperCollider'));
        const detail = tail
          .slice(banner + 1)
          .filter((l) => !l.startsWith('@field ') && l.trim() !== '')
          .slice(-OUTPUT_TAIL)
          .join('\n');
        const cause = lastError ?? `sclang exited with code ${code} before the voice host was ready`;
        return detail === '' ? cause : `${cause}\n${detail}`;
      };

      child.on('error', (err) => reject(new Error(`could not start sclang: ${err.message}`)));
      child.on('exit', (code) => {
        if (!ready) {
          void sendQuit(port);
          reject(new Error(why(code)));
        } else if (!host.closing) {
          void sendQuit(port);
          options.onExit?.(why(code));
        }
      });
      child.stderr.on('data', () => {});
      createInterface({ input: child.stdout }).on('line', (line) => {
        tail.push(line);
        if (tail.length > OUTPUT_TAIL * 4) tail.splice(0, tail.length - OUTPUT_TAIL * 4);
        const parsed = parseHostLine(line);
        if (parsed === undefined) return;
        if ('error' in parsed) lastError = parsed.error;
        else if ('ready' in parsed) {
          options.onStatus?.({ state: 'live', device: parsed.device, sampleRate: parsed.sample_rate });
          if (!ready) {
            ready = true;
            resolveHost(host);
          }
        } else if ('restarting' in parsed) options.onStatus?.({ state: 'restarting' });
        else if ('voice_on' in parsed) options.onStatus?.({ state: 'voice', note: parsed.voice_on, on: true });
        else options.onStatus?.({ state: 'voice', note: parsed.voice_off, on: false });
      });
    });
  }

  // /quit goes to scsynth directly, so the server stops even when sclang
  // is wedged; sclang then gets SIGTERM, and SIGKILL if it lingers.
  async close(timeoutMs = 3000): Promise<void> {
    this.closing = true;
    await sendQuit(this.port);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      this.child.kill('SIGTERM');
    });
  }
}
