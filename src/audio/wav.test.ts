import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav, writeWavFloat32 } from './wav.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-wav-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Hand-build a PCM WAV: the reader must handle files we did not write.
function pcmWav(opts: {
  bits: 16 | 24 | 32;
  channels: number;
  sampleRate: number;
  frames: number[][]; // frames[frame][channel], in [-1, 1)
  extensible?: boolean;
}): Buffer {
  const bytes = opts.bits / 8;
  const fmtSize = opts.extensible ? 40 : 16;
  const dataSize = opts.frames.length * opts.channels * bytes;
  const buf = Buffer.alloc(12 + 8 + fmtSize + 8 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(fmtSize, 16);
  buf.writeUInt16LE(opts.extensible ? 0xfffe : 1, 20);
  buf.writeUInt16LE(opts.channels, 22);
  buf.writeUInt32LE(opts.sampleRate, 24);
  buf.writeUInt32LE(opts.sampleRate * opts.channels * bytes, 28);
  buf.writeUInt16LE(opts.channels * bytes, 32);
  buf.writeUInt16LE(opts.bits, 34);
  if (opts.extensible) {
    buf.writeUInt16LE(22, 36); // cbSize
    buf.writeUInt16LE(opts.bits, 38); // valid bits
    buf.writeUInt32LE(0, 40); // channel mask
    buf.writeUInt16LE(1, 44); // SubFormat GUID starts with the format tag: PCM
  }
  const dataAt = 12 + 8 + fmtSize;
  buf.write('data', dataAt);
  buf.writeUInt32LE(dataSize, dataAt + 4);
  let at = dataAt + 8;
  const full = 2 ** (opts.bits - 1); // not 1 << 31, which overflows to negative

  for (const frame of opts.frames) {
    for (let ch = 0; ch < opts.channels; ch++) {
      const v = Math.max(-full, Math.min(full - 1, Math.round(frame[ch]! * full)));
      buf.writeIntLE(v, at, bytes);
      at += bytes;
    }
  }
  return buf;
}

describe('readWav', () => {
  it.each([16, 24, 32] as const)('decodes %d-bit PCM', (bits) => {
    const path = join(dir, 'a.wav');
    writeFileSync(
      path,
      pcmWav({ bits, channels: 2, sampleRate: 48000, frames: [[0.5, -0.5], [0, 0.25]] }),
    );
    const wav = readWav(path);
    expect(wav.sampleRate).toBe(48000);
    expect(wav.channels).toHaveLength(2);
    expect(wav.channels[0]![0]).toBeCloseTo(0.5, 3);
    expect(wav.channels[1]![0]).toBeCloseTo(-0.5, 3);
    expect(wav.channels[1]![1]).toBeCloseTo(0.25, 3);
  });

  it('decodes WAVE_FORMAT_EXTENSIBLE by its SubFormat tag', () => {
    const path = join(dir, 'ext.wav');
    writeFileSync(
      path,
      pcmWav({ bits: 24, channels: 1, sampleRate: 44100, frames: [[0.5]], extensible: true }),
    );
    const wav = readWav(path);
    expect(wav.sampleRate).toBe(44100);
    expect(wav.channels[0]![0]).toBeCloseTo(0.5, 4);
  });

  it('rejects unsupported encodings with the format named', () => {
    const path = join(dir, 'alaw.wav');
    const buf = pcmWav({ bits: 16, channels: 1, sampleRate: 8000, frames: [[0]] });
    buf.writeUInt16LE(6, 20); // A-law
    writeFileSync(path, buf);
    expect(() => readWav(path)).toThrow('unsupported WAV encoding (format 6');
  });

  it('rejects non-WAV files', () => {
    const path = join(dir, 'not.wav');
    writeFileSync(path, 'just some text, definitely not RIFF');
    expect(() => readWav(path)).toThrow('not a RIFF/WAVE file');
  });
});

describe('writeWavFloat32', () => {
  it('round-trips float samples exactly', () => {
    const path = join(dir, 'f.wav');
    const left = Float32Array.from([0, 0.25, -1, 0.999]);
    const right = Float32Array.from([1, -0.25, 0, -0.999]);
    writeWavFloat32(path, 96000, [left, right]);
    const wav = readWav(path);
    expect(wav.sampleRate).toBe(96000);
    expect([...wav.channels[0]!]).toEqual([...left]);
    expect([...wav.channels[1]!]).toEqual([...right]);
  });

  it('refuses mismatched channel lengths', () => {
    expect(() =>
      writeWavFloat32(join(dir, 'x.wav'), 48000, [new Float32Array(2), new Float32Array(3)]),
    ).toThrow('equal lengths');
  });
});
