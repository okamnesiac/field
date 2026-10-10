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
  console.log('compiling class library...');
  console.log('*** Welcome to SuperCollider 3.14.1. *** For help type cmd-d.');
  switch (process.env.STUB_MODE) {
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
process.on('SIGTERM', () => process.exit(0));
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
    expect(instrumentPath('still-water-pad', '/p')).toBe('/p/shared/instruments/still-water-pad.scd');
    expect(instrumentPath('still-water-pad.scd', '/p')).toBe('/p/shared/instruments/still-water-pad.scd');
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
  it('starts sclang on the host script in voice mode and resolves when it is ready', async () => {
    const statuses: VoiceHostStatus[] = [];
    const host = await VoiceHost.start({
      instrument: '/p/pad.scd',
      device: 'Test Out',
      env: env('ready'),
      onStatus: (s) => statuses.push(s),
    });
    expect(statuses).toEqual([{ state: 'live', device: 'Test Out', sampleRate: 48000 }]);
    const seen = JSON.parse(readFileSync(`${log}.env`, 'utf8'));
    expect(seen.args[0]).toBe('-D');
    expect(seen.args[1]).toMatch(/sc\/voice-host\.scd$/);
    expect(existsSync(seen.args[1])).toBe(true);
    expect(seen).toMatchObject({ mode: 'voice', instrument: '/p/pad.scd', device: 'Test Out', parent: String(process.pid) });
    await host.close();
    expect(readFileSync(log, 'latin1')).toContain('/quit');
  });

  it('rejects with the host error and what sclang printed after its banner', async () => {
    const start = VoiceHost.start({ instrument: '/p/x.scd', env: env('error') });
    await expect(start).rejects.toThrow('x.scd does not answer FIELD_MODE=voice\nERROR: a parse error the user needs to see');
    await expect(start).rejects.not.toThrow(/compiling class library/);
  });

  it('rejects when sclang exits before it is ready', async () => {
    await expect(VoiceHost.start({ instrument: '/p/x.scd', env: env('silent') })).rejects.toThrow(
      /exited with code 0 before the voice host was ready/,
    );
  });

  it('reports a restart, then a host that dies on its own, with its error', async () => {
    const statuses: VoiceHostStatus[] = [];
    const reasons: string[] = [];
    await VoiceHost.start({
      instrument: '/p/x.scd',
      env: env('ready-then-die'),
      onStatus: (s) => statuses.push(s),
      onExit: (reason) => reasons.push(reason),
    });
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
