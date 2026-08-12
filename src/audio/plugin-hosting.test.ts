// Hosted plugins, chunk 1 (plugin-hosting.md): the fixture plugin is
// the plugin these tests own (decision 12), scanned and rendered
// hermetically — FIELD_PLUGIN_PATH points the daemon at the built
// artefact, so nothing here touches the machine's real plugin folders.
// VST3 is the format under test because it exists on every platform CI
// runs; the AU path is exercised by the same code and proven on the
// local gate, the same split the workflow header records for CoreAudio.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { daemonBinary } from '../audiod/client.js';
import { pluginInfoSchema, type PluginInfo } from './plugins.js';
import { renderInsertChain } from './render-daemon.js';
import { writeWavFloat32 } from './wav.js';

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

// The built fixture sits beside the daemon binary's build tree.
const fixtureDir =
  binary === undefined
    ? undefined
    : join(dirname(binary), '..', '..', 'field-fixture_artefacts', 'Release', 'VST3');
const haveFixture = fixtureDir !== undefined && existsSync(fixtureDir);

const RATE = 48000;

function scanFixture(): PluginInfo {
  const out = execFileSync(binary!, ['--scan', 'vst3'], {
    encoding: 'utf8',
    env: { ...process.env, FIELD_PLUGIN_PATH: fixtureDir! },
  });
  const lines = out.split('\n').filter((line) => line.trim() !== '');
  const plugins = lines.map((line) => pluginInfoSchema.parse(JSON.parse(line)));
  const fixture = plugins.find((p) => p.name === 'Field Fixture');
  if (fixture === undefined) throw new Error(`fixture not found in scan: ${out}`);
  return fixture;
}

function readWavData(path: string): { channels: Float32Array[]; frames: number } {
  const bytes = readFileSync(path);
  // Minimal float32 WAV reader for assertions: find the data chunk.
  let offset = 12;
  let dataOffset = -1;
  let dataLength = 0;
  let channels = 2;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') channels = bytes.readUInt16LE(offset + 10);
    if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('no data chunk');
  const sampleCount = dataLength / 4;
  const frames = sampleCount / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < sampleCount; i++) {
    out[i % channels]![Math.floor(i / channels)] = bytes.readFloatLE(dataOffset + i * 4);
  }
  return { channels: out, frames };
}

const constantTransport = { segments: [{ sample: 0, ppq: 0, bpm: 120, numerator: 4, denominator: 4 }] };

describe.skipIf(!binary || !haveFixture)('hosted plugin renders (plugin-hosting.md chunk 1)', () => {
  let dir: string;
  let fixture: PluginInfo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'field-hosting-test-'));
    process.env['FIELD_PLUGIN_PATH'] = fixtureDir!;
    fixture ??= scanFixture();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['FIELD_PLUGIN_PATH'];
  });

  function inputWav(samples?: Float32Array): string {
    const path = join(dir, 'in.wav');
    const data =
      samples ??
      Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE));
    writeWavFloat32(path, RATE, [data, data]);
    return path;
  }

  function pluginInsert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      effect: 'plugin',
      format: 'vst3',
      identifier: fixture.identifier,
      name: fixture.name,
      version: fixture.version,
      latency: 0,
      params: [],
      transport: constantTransport,
      path: fixture.path,
      ...overrides,
    };
  }

  async function render(insert: Record<string, unknown>, input?: string): Promise<string> {
    const output = join(dir, `out-${Math.random().toString(36).slice(2)}.wav`);
    await renderInsertChain({
      op: 'stem',
      output,
      sample_rate: RATE,
      inputs: [input ?? inputWav()],
      clips: [
        { input: 0, start: 0, duration: 4800, read_offset: 0, gain_db: 0, fade_in: 0, fade_out: 0 },
      ],
      // The wire type is exercised by the real path in stem.execute;
      // here the plan is hand-built, which is what the daemon validates.
      inserts: [insert] as never,
    });
    return output;
  }

  it('scan describes the fixture: identity, params, the duplicate Trim pair', () => {
    expect(fixture.format).toBe('vst3');
    expect(fixture.version).toBe('1.0.0');
    const trims = fixture.params.filter((p) => p.name === 'Trim');
    expect(trims).toHaveLength(2);
    expect(new Set(trims.map((t) => t.id)).size).toBe(2);
    expect(fixture.params.some((p) => p.name === 'Gain')).toBe(true);
    // Discreteness and labels ride the scan (decision 3's split).
    const ratio = fixture.params.find((p) => p.name === 'Ratio');
    expect(ratio?.discrete).toBe(true);
    expect(ratio?.labels).toContain('4:1');
  });

  it('refuses a string spelling on a continuous parameter (decision 3, minjudd)', async () => {
    await expect(
      render(pluginInsert({ params: [{ name: 'Gain', value: '3.1 ms' }] })),
    ).rejects.toThrow(/takes a number/);
  });

  it('renders deterministically and applies natural-unit params', async () => {
    const input = inputWav();
    const a = await render(pluginInsert({ params: [{ name: 'Gain', value: 6 }] }), input);
    const b = await render(pluginInsert({ params: [{ name: 'Gain', value: 6 }] }), input);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);

    const plain = await render(pluginInsert(), input);
    const gained = readWavData(a).channels[0]!;
    const flat = readWavData(plain).channels[0]!;
    // +6 dB is ×1.995; measure at a hot sample well past the start.
    const k = 55; // near the 220 Hz peak
    expect(gained[k]! / flat[k]!).toBeCloseTo(Math.pow(10, 6 / 20), 3);
  });

  it('restores the blob first, then overlays params (decision 5)', async () => {
    // Blobs are captured, never hand-written (decision 7): a hosted
    // instance's state stream has framing of its own, which is the whole
    // reason the chunk is opaque. The capture carries a DC offset no
    // parameter exposes (the fixture's env hook) plus a gain the render
    // params contradict — the offset must survive, the params must win.
    const blobPath = join(dir, 'blob.state');
    execFileSync(
      binary!,
      ['--state-capture', 'vst3', fixture.identifier, JSON.stringify([{ name: 'Gain', value: -24 }]), blobPath],
      { env: { ...process.env, FIELD_PLUGIN_PATH: fixtureDir!, FIELD_FIXTURE_OFFSET: '0.25' } },
    );

    const silent = new Float32Array(4800); // silence isolates the offset
    const out = await render(
      pluginInsert({ state_path: blobPath, params: [{ name: 'Gain', value: 0 }] }),
      inputWav(silent),
    );
    const data = readWavData(out).channels[0]!;
    // Offset present: the blob's non-param state was restored…
    expect(data[100]).toBeCloseTo(0.25, 5);
    // …and a render with the blob's gain -24 NOT overlaid would differ on
    // real content; prove the overlay by measuring tone through both.
    const tone = await render(
      pluginInsert({ state_path: blobPath, params: [{ name: 'Gain', value: 0 }] }),
    );
    const flat = await render(pluginInsert({ params: [{ name: 'Gain', value: 0 }] }));
    const toneData = readWavData(tone).channels[0]!;
    const flatData = readWavData(flat).channels[0]!;
    // Same tone amplitude (params won over the blob's -24), plus the DC.
    expect(toneData[55]! - 0.25).toBeCloseTo(flatData[55]!, 3);
  });

  it('supplies the playhead both ways: the beat gate follows the plan tempo (decision 13)', async () => {
    const loud = Float32Array.from({ length: 4800 }, () => 0.5);
    const input = inputWav(loud);
    const gated120 = await render(
      pluginInsert({ params: [{ name: 'Beat Gate', value: 1 }] }),
      input,
    );
    const data = readWavData(gated120).channels[0]!;
    // At 120 bpm a beat is 24000 samples; the first half of beat one is
    // full level, so inside 4800 samples everything is ungated…
    expect(data[1000]).toBeCloseTo(0.5, 4);

    // …at 600 bpm a beat is 4800 samples, so sample 3000 sits in the
    // second half: gated to a quarter.
    const gated600 = await render(
      pluginInsert({
        params: [{ name: 'Beat Gate', value: 1 }],
        transport: { segments: [{ sample: 0, ppq: 0, bpm: 600, numerator: 4, denominator: 4 }] },
      }),
      input,
    );
    const fast = readWavData(gated600).channels[0]!;
    expect(fast[1000]).toBeCloseTo(0.5, 4);
    expect(fast[3000]).toBeCloseTo(0.125, 4);
  });

  it('trims declared latency so the output stays aligned (decision 11)', async () => {
    const impulse = new Float32Array(4800);
    impulse[300] = 1;
    const out = await render(
      pluginInsert({
        latency: 128,
        params: [{ name: 'Latency', value: 128 }],
      }),
      inputWav(impulse),
    );
    const data = readWavData(out).channels[0]!;
    expect(data[300]).toBeCloseTo(1, 4);
    expect(Math.abs(data[300 - 128]!)).toBeLessThan(1e-6);
  });

  it('refuses a latency the plugin does not report (decision 11, Bugbot)', async () => {
    // The Latency param makes the fixture actually exhibit 64 samples;
    // the insert still declares 0, which is exactly the stale-pin case
    // that used to render with PDC quietly wrong.
    await expect(
      render(pluginInsert({ params: [{ name: 'Latency', value: 64 }] })),
    ).rejects.toThrow(/reports 64 samples of latency but the insert declares 0/);
  });

  it('splits blocks at tempo-segment boundaries mid-block (decision 13, Bugbot)', async () => {
    // Segment 2 lands at sample 960 — inside the [512, 1024) block. At
    // bpm 1 the gate never leaves its first half; at bpm 60000 a beat
    // is 48 samples, so sample 990 sits in a gated quarter-level span.
    // Without the split, the block would carry segment 1's playhead and
    // render 990 at full level.
    const loud = Float32Array.from({ length: 4800 }, () => 0.5);
    const out = await render(
      pluginInsert({
        params: [{ name: 'Beat Gate', value: 1 }],
        transport: {
          segments: [
            { sample: 0, ppq: 0, bpm: 1, numerator: 4, denominator: 4 },
            { sample: 960, ppq: 1 / 3000, bpm: 60000, numerator: 4, denominator: 4 },
          ],
        },
      }),
      inputWav(loud),
    );
    const data = readWavData(out).channels[0]!;
    expect(data[970]).toBeCloseTo(0.5, 4); // first half of a fast beat
    expect(data[990]).toBeCloseTo(0.125, 4); // second half: quarter level
  });

  it('renders a declared tail exactly and rings out an undeclared one (decision 11)', async () => {
    const declared = await render(pluginInsert({ tail: 0.01 }));
    expect(readWavData(declared).frames).toBe(4800 + 480);

    // The fixture decays instantly, so ring-out truncates at the input
    // edge rather than padding a cap's worth of silence.
    const detected = await render(pluginInsert());
    expect(readWavData(detected).frames).toBe(4800);
  });

  it('pads the render by latency so lengths survive the trim (Codex)', async () => {
    // Declared tail with latency: the run renders tail + latency and
    // trims back to exactly input + tail — the pre-fix code delivered
    // input + tail − latency.
    const declared = await render(
      pluginInsert({ tail: 0.01, latency: 128, params: [{ name: 'Latency', value: 128 }] }),
    );
    expect(readWavData(declared).frames).toBe(4800 + 480);

    // A silent stem under ring-out keeps its full length too; the
    // pre-fix code returned it short by the latency.
    const silent = await render(
      pluginInsert({ latency: 128, params: [{ name: 'Latency', value: 128 }] }),
      inputWav(new Float32Array(4800)),
    );
    expect(readWavData(silent).frames).toBe(4800);
  });

  it('refuses a Name#<id> whose name disagrees with the id (Codex)', async () => {
    const gainId = fixture.params.find((p) => p.name === 'Gain')!.id;
    await expect(
      render(pluginInsert({ params: [{ name: `Trim#${gainId}`, value: 1 }] })),
    ).rejects.toThrow(/is named "Gain", not "Trim"/);
  });

  it('labeled params take their label; unrecognized spellings refuse (Codex)', async () => {
    const input = inputWav();
    const halved = await render(
      pluginInsert({ params: [{ name: 'Ratio', value: '4:1' }] }),
      input,
    );
    const flat = await render(pluginInsert(), input);
    const a = readWavData(halved).channels[0]!;
    const b = readWavData(flat).channels[0]!;
    expect(a[55]! / b[55]!).toBeCloseTo(0.5, 3);

    await expect(render(pluginInsert({ params: [{ name: 'Ratio', value: 3 }] }))).rejects.toThrow(
      /spell the value as the plugin displays it/,
    );
  });

  it('refuses a bare name matching two params and takes Name#<id> (decision 3)', async () => {
    await expect(render(pluginInsert({ params: [{ name: 'Trim', value: 2 }] }))).rejects.toThrow(
      /2 parameters named "Trim"/,
    );

    const trims = fixture.params.filter((p) => p.name === 'Trim');
    const out = await render(
      pluginInsert({
        params: trims.map((t) => ({ name: `Trim#${t.id}`, value: 3 })),
      }),
    );
    const data = readWavData(out).channels[0]!;
    const flat = readWavData(await render(pluginInsert())).channels[0]!;
    expect(data[55]! / flat[55]!).toBeCloseTo(Math.pow(10, 6 / 20), 3);
  });

  it('refuses a version drift at instantiation, naming both versions (decision 9)', async () => {
    await expect(render(pluginInsert({ version: '9.9.9' }))).rejects.toThrow(
      /pinned at 9\.9\.9 but the installed version is 1\.0\.0/,
    );
  });

  it('refuses a plan whose plugin insert carries no transport (decision 13)', async () => {
    await expect(render(pluginInsert({ transport: { segments: [] } }))).rejects.toThrow(
      /tempo segment/,
    );
  });

  it('refuses an uninstalled plugin by name, format, identity and version', async () => {
    await expect(render(pluginInsert({ identifier: 'deadbeef' }))).rejects.toThrow(
      /needs Field Fixture \(vst3 deadbeef 1\.0\.0\), which is not installed/,
    );
  });
});

describe.skipIf(!binary || !haveFixture)('hosted chains under live compile (chunk 1)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'field-hosting-live-'));
    process.env['FIELD_PLUGIN_PATH'] = fixtureDir!;
    fixture ??= scanFixture();
    const { init } = await import('../commands/init.js');
    const { createSong } = await import('../commands/create.js');
    init({ dir: root, name: 'test-album' });
    createSong(root, 'opener');
    const tone = Float32Array.from({ length: 4800 }, (_, i) =>
      0.4 * Math.sin((2 * Math.PI * 220 * i) / RATE),
    );
    writeWavFloat32(join(root, 'tone.wav'), RATE, [tone, tone]);
    const { importAsset } = await import('../commands/import.js');
    await importAsset(root, 'opener', join(root, 'tone.wav'), 'tone');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env['FIELD_PLUGIN_PATH'];
  });

  let fixture!: PluginInfo;

  function hostedTrack(): string {
    return [
      'name: lead',
      'inserts:',
      '  - plugin: Field Fixture',
      `    vst3: ${fixture.identifier}`,
      `    version: ${fixture.version}`,
      '    params:',
      '      Gain: 6',
      'inputs:',
      '  - audio: tone',
      '',
    ].join('\n');
  }

  it('freezes a dirty hosted chain by rendering it, and sends no plugin arm live', async () => {
    writeFileSync(join(root, 'songs/opener/tracks/lead.yaml'), hostedTrack());
    // Reachability matters: an unplaced track drops from the session
    // entirely, which would pass the no-plugin assertion vacuously.
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      'name: main\ninputs:\n  - track: lead\n',
    );
    const { compileSession } = await import('../graph/live.js');
    const compiled = await compileSession(root, 'opener');
    const serialized = JSON.stringify(compiled.session);
    // No plugin arm reaches the daemon, the chain is not in the dirty
    // list (the compile just rendered it), and the frozen stem arrives
    // as a file window on its consumer.
    expect(serialized).not.toContain('"plugin"');
    expect(compiled.dirty).not.toContain('//songs/opener/track:lead');
    expect(serialized).toContain('track/lead.wav');
  });

  it('refuses a hosted chain on the output track, naming chunk 2', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/main.yaml'),
      [
        'name: main',
        'inserts:',
        '  - plugin: Field Fixture',
        `    vst3: ${fixture.identifier}`,
        `    version: ${fixture.version}`,
        'inputs:',
        '  - audio: tone',
        '',
      ].join('\n'),
    );
    const { compileSession } = await import('../graph/live.js');
    await expect(compileSession(root, 'opener')).rejects.toThrow(
      /cannot run live yet \(plugin-hosting\.md chunk 2\)/,
    );
  });
});

describe.skipIf(!binary || !haveFixture)('scan output shape', () => {
  it('emits parseable NDJSON the inventory schema accepts', () => {
    const out = execFileSync(binary!, ['--scan', 'vst3'], {
      encoding: 'utf8',
      env: { ...process.env, FIELD_PLUGIN_PATH: fixtureDir! },
    });
    const lines = out.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      const failure = z.object({ failed: z.string() }).safeParse(parsed);
      if (!failure.success) pluginInfoSchema.parse(parsed);
    }
  });
});
