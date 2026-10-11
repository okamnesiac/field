import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { instrumentProgram, sclangCommand, scScript } from '../generators/supercollider.js';

export function voiceHostScript(): string {
  return scScript('voice-host.scd');
}

// An instrument name resolves exactly as a supercollider: entry's source
// does, after `.scd` is added to a name without an extension
// (keyboard-instrument.md §2.1).
export function instrumentPath(spec: string, root: string): string {
  const relative = instrumentProgram(spec);
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

function sendOsc(address: string, port: number): Promise<void> {
  return new Promise((done) => {
    const socket = createSocket('udp4');
    socket.send(oscMessage(address), port, '127.0.0.1', () => socket.close(() => done()));
  });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (running(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

const hostLine = z.union([
  z.object({ ready: z.literal(true), device: z.string(), sample_rate: z.number() }),
  z.object({ restarting: z.literal(true) }),
  z.object({ server_pid: z.number().int().positive() }),
  z.object({ error: z.string() }),
  z.object({ voice_on: z.number() }),
  z.object({ voice_off: z.number() }),
  z.object({ reloaded: z.literal(true) }),
  z.object({ reload_error: z.string() }),
]);

export type VoiceHostStatus =
  | { state: 'live'; device: string; sampleRate: number }
  | { state: 'restarting' }
  | { state: 'voice'; note: number; on: boolean }
  // The program was loaded again after its file changed (§14): the next
  // note plays the new voice, or, when it failed, still the last good one.
  | { state: 'reloaded' }
  | { state: 'reload-failed'; reason: string };

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
  // The scsynth the host launched last, which `close` stops by process:
  // one that is still booting has not bound its port, so /quit misses it.
  private serverPid: number | undefined;
  // sclang's first ERROR line since the last reload: a program that does
  // not compile says why only there.
  private reloadError: string | undefined;
  // Settles when the host first goes live, or rejects with why it did not.
  readonly ready: Promise<void>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly port: number,
    private readonly langPort: number,
    options: VoiceHostOptions,
  ) {
    // sclang reports compile and runtime errors on stdout, so the tail of
    // it is what explains a host that never became ready.
    const tail: string[] = [];
    this.ready = new Promise((resolveReady, reject) => {
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
        void this.stopServer();
        if (!ready) reject(new Error(this.closing ? 'the voice host was closed before it was ready' : why(code)));
        else if (!this.closing) options.onExit?.(why(code));
      });
      child.stderr.on('data', () => {});
      createInterface({ input: child.stdout }).on('line', (line) => {
        tail.push(line);
        if (line.startsWith('ERROR:')) this.reloadError ??= line.slice('ERROR:'.length).trim();
        if (tail.length > OUTPUT_TAIL * 4) tail.splice(0, tail.length - OUTPUT_TAIL * 4);
        const parsed = parseHostLine(line);
        if (parsed === undefined) return;
        if ('error' in parsed) lastError = parsed.error;
        else if ('server_pid' in parsed) this.serverPid = parsed.server_pid;
        else if ('ready' in parsed) {
          options.onStatus?.({ state: 'live', device: parsed.device, sampleRate: parsed.sample_rate });
          if (!ready) {
            ready = true;
            resolveReady();
          }
        } else if ('restarting' in parsed) options.onStatus?.({ state: 'restarting' });
        else if ('voice_on' in parsed) options.onStatus?.({ state: 'voice', note: parsed.voice_on, on: true });
        else if ('voice_off' in parsed) options.onStatus?.({ state: 'voice', note: parsed.voice_off, on: false });
        else if ('reloaded' in parsed) options.onStatus?.({ state: 'reloaded' });
        else {
          const detail = this.reloadError;
          options.onStatus?.({ state: 'reload-failed', reason: detail === undefined ? parsed.reload_error : `${parsed.reload_error}: ${detail}` });
        }
      });
    });
    // Whoever starts a host awaits `ready`; until then a rejection is
    // reported there, not as an unhandled one.
    this.ready.catch(() => {});
  }

  // Resolves once sclang is running, so a host can be closed while it is
  // still booting; `ready` says when it goes live.
  static async start(options: VoiceHostOptions): Promise<VoiceHost> {
    const env = options.env ?? process.env;
    const port = await freeUdpPort();
    // sclang's own port, where `reload` reaches it.
    const langPort = await freeUdpPort();
    const child = spawn(sclangCommand(env), ['-u', String(langPort), '-D', voiceHostScript()], {
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
    return new VoiceHost(child, port, langPort, options);
  }

  // Asks the host to load the instrument's program again, as its file has
  // changed; the result arrives as a `reloaded` or `reload-failed` status.
  reload(): Promise<void> {
    this.reloadError = undefined;
    return sendOsc('/field/reload', this.langPort);
  }

  // /quit, then the server's process if it lingers, then sclang: SIGTERM,
  // and SIGKILL if it lingers too.
  async close(timeoutMs = 3000): Promise<void> {
    this.closing = true;
    await this.stopServer();
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

  private async stopServer(): Promise<void> {
    await sendOsc('/quit', this.port);
    const pid = this.serverPid;
    if (pid === undefined || (await exited(pid, 500))) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone between the check and the signal
    }
  }
}
