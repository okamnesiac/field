import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInstrument } from '../commands/keys.js';
import { freeUdpPort, instrumentPath, oscMessage, parseHostLine, VoiceHost, type VoiceHostStatus } from './voice-host.js';

// A stand-in for sclang running the voice host: it records its
// environment, listens on the scsynth port it was given, records an OSC
// /quit there, and behaves as STUB_MODE says.
const STUB = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const log = process.env.STUB_LOG;
writeFileSync(log + '.env', JSON.stringify({
  args: process.argv.slice(2),
  mode: process.env.FIELD_MODE,
  instrument: process.env.FIELD_INSTRUMENT,
  device: process.env.FIELD_DEVICE ?? null,
  parent: process.env.FIELD_PARENT_PID,
}));
const socket = require('node:dgram').createSocket('udp4');
socket.on('message', (msg) => appendFileSync(log, msg.toString('latin1') + '\\n'));
socket.bind(Number(process.env.FIELD_SC_PORT), '127.0.0.1', () => {
  // The log exists from the moment the port is bound.
  appendFileSync(log, '');
  console.log('compiling class library...');
  console.log('*** Welcome to SuperCollider 3.14.1. *** For help type cmd-d.');
  if (process.env.STUB_SERVER) {
    // A server that ignores /quit, as a booting scsynth does, and outlives
    // the stub unless something stops it by process.
    const server = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore', detached: true });
    server.unref();
    writeFileSync(log + '.server', String(server.pid));
    console.log('@field {"server_pid":' + server.pid + '}');
  }
  switch (process.env.STUB_MODE) {
    case 'hang':
      break;
    case 'ready':
      console.log('@field {"ready":true,"device":"Test Out","sample_rate":48000}');
      break;
    case 'error':
      console.log('ERROR: a parse error the user needs to see');
      console.log('@field {"error":"x.scd does not answer FIELD_MODE=voice"}');
      process.exit(1);
    case 'silent':
      process.exit(0);
    case 'ready-then-die':
      console.log('@field {"ready":true,"device":"Test Out","sample_rate":48000}');
      setTimeout(() => {
        console.log('@field {"restarting":true}');
        console.log('@field {"error":"scsynth did not boot on Test Out"}');
        process.exit(1);
      }, 100);
      break;
  }
});
// A datagram that arrived just before the signal is still logged.
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
`;

let dir: string;
let stub: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-voice-host-'));
  stub = join(dir, 'sclang');
  log = join(dir, 'received.log');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function env(mode: string): NodeJS.ProcessEnv {
  return { ...process.env, FIELD_SCLANG: stub, STUB_LOG: log, STUB_MODE: mode };
}

describe('resolving an instrument', () => {
  it('adds .scd and resolves a bare name on the instruments shelf', () => {
    expect(instrumentPath('pad', '/p')).toBe('/p/shared/instruments/pad.scd');
    expect(instrumentPath('pad.scd', '/p')).toBe('/p/shared/instruments/pad.scd');
  });

  it('resolves a slashed path from the root, and leaves an absolute path alone', () => {
    expect(instrumentPath('songs/creek/voice', '/p')).toBe('/p/songs/creek/voice.scd');
    expect(instrumentPath('/elsewhere/voice.scd', '/p')).toBe('/elsewhere/voice.scd');
  });

  it('refuses a bare name outside a project, and a program that does not exist', () => {
    expect(() => resolveInstrument('pad', dir)).toThrow(/not inside a Field project/);
    writeFileSync(join(dir, 'field.yaml'), 'name: t\n');
    mkdirSync(join(dir, 'shared/instruments'), { recursive: true });
    expect(() => resolveInstrument('pad', dir)).toThrow(/no instrument program at .*shared\/instruments\/pad\.scd/);
    writeFileSync(join(dir, 'shared/instruments/pad.scd'), '');
    expect(resolveInstrument('pad', dir)).toBe(join(dir, 'shared/instruments/pad.scd'));
  });

  it('lists the shelf when a name is not on it, split by whether each plays from notes', () => {
    writeFileSync(join(dir, 'field.yaml'), 'name: t\n');
    mkdirSync(join(dir, 'shared/instruments'), { recursive: true });
    expect(() => resolveInstrument('bass', dir)).toThrow(/shared\/instruments\/ has no programs yet\.$/);
    writeFileSync(join(dir, 'shared/instruments/pad.scd'), '(\nif ("FIELD_MODE".getenv == "voice") { SynthDef(\\pad, {}) } { 0.exit }\n)\n');
    writeFileSync(join(dir, 'shared/instruments/kit.scd'), '// renders only\n');
    writeFileSync(join(dir, 'shared/instruments/pad.v2.scd'), '// FIELD_MODE, a later pad\n');
    writeFileSync(join(dir, 'shared/instruments/notes.txt'), 'FIELD_MODE\n');
    mkdirSync(join(dir, 'shared/instruments/folder.scd'));
    expect(() => resolveInstrument('bass', dir)).toThrow(
      `field keys bass: no instrument program at ${join(dir, 'shared/instruments/bass.scd')}\n` +
        'In shared/instruments/:\n' +
        '  plays from notes: pad, pad.v2.scd\n' +
        "  renders only:     kit (no FIELD_MODE=voice branch; Field's docs/keys.md says how to add one)",
    );
    // Every listed name resolves.
    expect(resolveInstrument('pad.v2.scd', dir)).toBe(join(dir, 'shared/instruments/pad.v2.scd'));
  });
});

describe('the voice host protocol', () => {
  it('encodes an OSC message with no arguments', () => {
    expect(oscMessage('/quit').toString('latin1')).toBe('/quit\0\0\0,\0\0\0');
    expect(oscMessage('/quit').length % 4).toBe(0);
  });

  it('reads only @field lines', () => {
    expect(parseHostLine('@field {"ready":true,"device":"Out","sample_rate":44100}')).toEqual({
      ready: true,
      device: 'Out',
      sample_rate: 44100,
    });
    expect(parseHostLine('@field {"voice_on":60}')).toEqual({ voice_on: 60 });
    expect(parseHostLine('Booting server on 127.0.0.1')).toBeUndefined();
    expect(parseHostLine('@field {not json')).toBeUndefined();
    expect(parseHostLine('@field {"surprise":1}')).toBeUndefined();
  });

  it('finds a free UDP port', async () => {
    const port = await freeUdpPort();
    expect(port).toBeGreaterThan(0);
  });
});

describe('the voice host process', () => {
  function stopStrayServer(): void {
    try {
      process.kill(Number(readFileSync(`${log}.server`, 'utf8')), 'SIGKILL');
    } catch {
      // never started, or already stopped
    }
  }

  it('starts sclang on the host script in voice mode and is ready when the host says so', async () => {
    const statuses: VoiceHostStatus[] = [];
    const host = await VoiceHost.start({
      instrument: '/p/pad.scd',
      device: 'Test Out',
      env: env('ready'),
      onStatus: (s) => statuses.push(s),
    });
    await host.ready;
    expect(statuses).toEqual([{ state: 'live', device: 'Test Out', sampleRate: 48000 }]);
    const seen = JSON.parse(readFileSync(`${log}.env`, 'utf8'));
    expect(seen.args[0]).toBe('-D');
    expect(seen.args[1]).toMatch(/sc\/voice-host\.scd$/);
    expect(existsSync(seen.args[1])).toBe(true);
    expect(seen).toMatchObject({ mode: 'voice', instrument: '/p/pad.scd', device: 'Test Out', parent: String(process.pid) });
    await host.close();
    expect(readFileSync(log, 'latin1')).toContain('/quit');
  });

  it('rejects ready with the host error and what sclang printed after its banner', async () => {
    const host = await VoiceHost.start({ instrument: '/p/x.scd', env: env('error') });
    await expect(host.ready).rejects.toThrow('x.scd does not answer FIELD_MODE=voice\nERROR: a parse error the user needs to see');
    await expect(host.ready).rejects.not.toThrow(/compiling class library/);
  });

  it('rejects ready when sclang exits before it is ready', async () => {
    const host = await VoiceHost.start({ instrument: '/p/x.scd', env: env('silent') });
    await expect(host.ready).rejects.toThrow(/exited with code 0 before the voice host was ready/);
  });

  it('closes a host that is still booting, without waiting for it to be ready', async () => {
    const host = await VoiceHost.start({ instrument: '/p/x.scd', env: env('hang') });
    const deadline = Date.now() + 5000;
    while (!existsSync(log) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await host.close();
    await expect(host.ready).rejects.toThrow(/closed before it was ready/);
    expect(readFileSync(log, 'latin1')).toContain('/quit');
  });

  it('stops the server the host launched by process, when /quit cannot reach it', async () => {
    const host = await VoiceHost.start({ instrument: '/p/x.scd', env: { ...env('hang'), STUB_SERVER: '1' } });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(`${log}.server`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const server = Number(readFileSync(`${log}.server`, 'utf8'));
      await new Promise((r) => setTimeout(r, 100));
      await host.close();
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(server, 0)).toThrow();
    } finally {
      stopStrayServer();
    }
  });

  it('reports a restart, then a host that dies on its own, with its error', async () => {
    const statuses: VoiceHostStatus[] = [];
    const reasons: string[] = [];
    const host = await VoiceHost.start({
      instrument: '/p/x.scd',
      env: env('ready-then-die'),
      onStatus: (s) => statuses.push(s),
      onExit: (reason) => reasons.push(reason),
    });
    await host.ready;
    await new Promise((r) => setTimeout(r, 500));
    expect(statuses.at(-1)).toEqual({ state: 'restarting' });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^scsynth did not boot on Test Out/);
  });

  it('refuses a FIELD_SCLANG that does not exist', async () => {
    await expect(
      VoiceHost.start({ instrument: '/p/x.scd', env: { ...process.env, FIELD_SCLANG: join(dir, 'missing') } }),
    ).rejects.toThrow('FIELD_SCLANG points at a missing binary');
  });
});
