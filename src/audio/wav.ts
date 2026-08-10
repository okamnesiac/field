import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';

// Minimal WAV I/O for the offline mixer (mix-assembly.md §1: offline DSP is
// TypeScript; there is no deadline here). Reads the formats afconvert,
// SuperCollider, and DAW exports actually produce — 16/24/32-bit PCM and
// 32-bit float, including WAVE_FORMAT_EXTENSIBLE headers — and writes
// 32-bit float, the interchange format for stems and mixes. Whole-file
// buffers are fine at song scale; streaming can arrive with the daemon.

export interface WavData {
  sampleRate: number;
  channels: Float32Array[]; // one per channel, equal lengths
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

// Frame count without decoding or reading audio bytes — seek-based chunk
// walk, cheap enough for validate to call on every load (clip-looping.md
// §1.3: loops without `every` need source lengths, and "check is the
// gate" means validate must be able to afford the answer).
export interface WavHeader {
  sampleRate: number;
  channels: number;
  frames: number;
  // The encoding, not just the geometry: 1 is integer PCM, 3 is IEEE
  // float. `normalize` promises integer PCM at the declared depth, and
  // nothing could check that promise until this was here (#57 review) —
  // a decoded sample sits on the same grid either way, so only the tag
  // and the width distinguish the two writers.
  format: number;
  bitsPerSample: number;
}

// Header only — no decode. The render path needs a file's rate and
// channel count to diagnose a mismatch before handing the work to the
// daemon, and decoding a whole stem to learn two integers would be
// absurd. Keeping that check in the control plane is deliberate: the
// messages it produces are user-facing diagnostics, and those belong
// where every other diagnostic lives rather than duplicated into C++.
export function readWavHeader(path: string): WavHeader {
  const fd = openSync(path, 'r');
  try {
    return readHeaderFrom(fd, path);
  } finally {
    closeSync(fd);
  }
}

export function wavFrameCount(path: string): number {
  return readWavHeader(path).frames;
}

// One chunk walk, shared. Seek-based and cheap enough for validate to
// call on every load (clip-looping.md §1.3: loops without `every` need
// source lengths, and "check is the gate" means validate must be able to
// afford the answer).
function readHeaderFrom(fd: number, path: string): WavHeader {
  const fileSize = fstatSync(fd).size;
  const header = Buffer.alloc(12);
  if (
    readSync(fd, header, 0, 12, 0) !== 12 ||
    header.toString('ascii', 0, 4) !== 'RIFF' ||
    header.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let fmt:
    | {
        sampleRate: number;
        channels: number;
        bytesPerFrame: number;
        format: number;
        bitsPerSample: number;
      }
    | undefined;
  let dataBytes: number | undefined;
  const chunk = Buffer.alloc(8);
  // 26 rather than 16: an extensible fmt chunk carries the real format
  // tag in the first two bytes of its SubFormat GUID, at body + 24.
  const body16 = Buffer.alloc(26);
  let offset = 12;
  while (offset + 8 <= fileSize) {
    if (readSync(fd, chunk, 0, 8, offset) !== 8) break;
    const id = chunk.toString('ascii', 0, 4);
    const size = chunk.readUInt32LE(4);
    const body = offset + 8;
    // Rate, channels and bit depth sit at the same offsets in a plain and
    // an extensible fmt chunk. The *format tag* does not: an extensible
    // header says 0xfffe and puts the real one in its SubFormat GUID, so
    // reporting the outer tag would answer 65534 for a file `readWav`
    // decodes as plain PCM — two readers in this module disagreeing
    // about the same bytes (#57 review).
    if (id === 'fmt ' && size >= 16) {
      const want = Math.min(size, 26);
      if (readSync(fd, body16, 0, want, body) === want) {
        let format = body16.readUInt16LE(0);
        if (format === FORMAT_EXTENSIBLE && want >= 26) {
          format = body16.readUInt16LE(24);
        }
        fmt = {
          channels: body16.readUInt16LE(2),
          sampleRate: body16.readUInt32LE(4),
          bytesPerFrame: (body16.readUInt16LE(14) / 8) * body16.readUInt16LE(2),
          format,
          bitsPerSample: body16.readUInt16LE(14),
        };
      }
    } else if (id === 'data') {
      dataBytes = Math.min(size, Math.max(0, fileSize - body));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !fmt.bytesPerFrame || dataBytes === undefined) {
    throw new Error(`${path}: missing fmt or data chunk`);
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    frames: Math.floor(dataBytes / fmt.bytesPerFrame),
    format: fmt.format,
    bitsPerSample: fmt.bitsPerSample,
  };
}

export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + size <= buf.length) {
      let format = buf.readUInt16LE(body);
      if (format === FORMAT_EXTENSIBLE) {
        if (size < 40) throw new Error(`${path}: truncated extensible fmt chunk`);
        // The real format tag is the first two bytes of the SubFormat GUID.
        format = buf.readUInt16LE(body + 24);
      }
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt) throw new Error(`${path}: no fmt chunk`);
  if (!data) throw new Error(`${path}: no data chunk`);
  if (fmt.channels < 1) throw new Error(`${path}: fmt declares ${fmt.channels} channels`);

  const decode = sampleDecoder(fmt.format, fmt.bits);
  if (!decode) {
    throw new Error(
      `${path}: unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit) — ` +
        `supported: 16/24/32-bit PCM and 32-bit float`,
    );
  }
  const bytesPerSample = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * fmt.channels * bytesPerSample;
    for (let ch = 0; ch < fmt.channels; ch++) {
      channels[ch]![frame] = decode(data, base + ch * bytesPerSample);
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}

function sampleDecoder(
  format: number,
  bits: number,
): ((data: Buffer, at: number) => number) | undefined {
  if (format === FORMAT_FLOAT && bits === 32) {
    return (data, at) => data.readFloatLE(at);
  }
  if (format !== FORMAT_PCM) return undefined;
  switch (bits) {
    case 16:
      return (data, at) => data.readInt16LE(at) / 0x8000;
    case 24:
      return (data, at) => {
        const raw = data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16);
        return (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      };
    case 32:
      return (data, at) => data.readInt32LE(at) / 0x80000000;
    default:
      return undefined;
  }
}

export function writeWavFloat32(path: string, sampleRate: number, channels: Float32Array[]): void {
  const count = channels.length;
  if (count < 1) throw new Error('writeWavFloat32 needs at least one channel');
  const frames = channels[0]!.length;
  if (!channels.every((c) => c.length === frames)) {
    throw new Error('writeWavFloat32 channels must have equal lengths');
  }

  const dataSize = frames * count * 4;
  // RIFF + fmt (18 bytes: non-PCM carries cbSize) + fact (required for
  // non-PCM) + data.
  const buf = Buffer.alloc(12 + 8 + 18 + 8 + 4 + 8 + dataSize);
  let at = 0;
  buf.write('RIFF', at);
  buf.writeUInt32LE(buf.length - 8, at + 4);
  buf.write('WAVE', at + 8);
  at += 12;
  buf.write('fmt ', at);
  buf.writeUInt32LE(18, at + 4);
  buf.writeUInt16LE(FORMAT_FLOAT, at + 8);
  buf.writeUInt16LE(count, at + 10);
  buf.writeUInt32LE(sampleRate, at + 12);
  buf.writeUInt32LE(sampleRate * count * 4, at + 16); // byte rate
  buf.writeUInt16LE(count * 4, at + 20); // block align
  buf.writeUInt16LE(32, at + 22);
  buf.writeUInt16LE(0, at + 24); // cbSize
  at += 8 + 18;
  buf.write('fact', at);
  buf.writeUInt32LE(4, at + 4);
  buf.writeUInt32LE(frames, at + 8);
  at += 12;
  buf.write('data', at);
  buf.writeUInt32LE(dataSize, at + 4);
  at += 8;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < count; ch++) {
      buf.writeFloatLE(channels[ch]![frame]!, at);
      at += 4;
    }
  }
  writeFileSync(path, buf);
}

// The 12-byte RIFF/WAVE signature, and nothing more — full parsing is
// readWavHeader's. Content decides where an extension cannot be trusted:
// import and export both probe this so a WAV named .wave (or nothing)
// gets the same treatment a .wav does.
export function hasWavSignature(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    if (readSync(fd, bytes, 0, 12, 0) !== 12) return false;
    return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE';
  } finally {
    closeSync(fd);
  }
}
