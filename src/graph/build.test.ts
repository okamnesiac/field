import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { buildLabels, explainLabel, projectRelative, queryDeps } from '../commands/build.js';
import { resolvePlayables } from '../commands/play.js';
import { runScProgram } from '../generators/supercollider.js';
import type { GeneratorRunner } from './build.js';

let root: string;

// A tiny valid 48 kHz 16-bit mono WAV (100 samples of silence).
function writeWav(path: string): void {
  const n = 100;
  const data = Buffer.alloc(n * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

// One file per track (project-layout.md §1.3, §4): tracks/<name>.yaml.
const writeTrack = (name: string, yaml: string) => {
  mkdirSync(join(root, 'songs/creek/tracks'), { recursive: true });
  writeFileSync(join(root, `songs/creek/tracks/${name}.yaml`), yaml);
};

// The canonical declared rule for these tests: a wrapper track with one
// insert — the shape every effect sound folded into (nested-tracks.md
// §18, decision 12). The frequency is the parameter the re-key tests
// turn.
const eqTrackYaml = (frequency: number) =>
  [
    'name: pad-eq',
    'inserts:',
    '  - effect: eq',
    '    bands:',
    '      - type: lowpass',
    `        frequency: ${frequency}`,
    'inputs:',
    '  - audio: pad',
    '',
  ].join('\n');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'field-build-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  const src = join(root, '..', `field-build-src-${Math.random()}.wav`);
  writeWav(src);
  await importAsset(root, 'creek', src, 'pad');
  rmSync(src);
  writeTrack('pad-eq', eqTrackYaml(700));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const countingRunner = () => {
  const state = { runs: 0 };
  const runner: GeneratorRunner = async (node, inputPaths, outputPath) => {
    state.runs++;
    // Rules with asset inputs copy the first through; input-less rules
    // (sc-render) get deterministic placeholder content.
    if (inputPaths.length > 0) copyFileSync(inputPaths[0]!, outputPath);
    else writeFileSync(outputPath, `out:${node.label.pkg}:${node.label.name}`);
  };
  return { state, runner };
};

describe('projectRelative', () => {
  it('strips the project root, which is the same on every line', () => {
    expect(projectRelative('/p', '/p/.field/out/songs/creek/mix/main.wav')).toBe(
      '.field/out/songs/creek/mix/main.wav',
    );
    expect(projectRelative('/p', '/p/songs/creek/audio/pad.wav')).toBe('songs/creek/audio/pad.wav');
  });

  it('keeps a path outside the project absolute rather than spelling it in ../..', () => {
    // The one case where the prefix carries information: it says the
    // file is not in this project.
    expect(projectRelative('/p', '/elsewhere/pad.wav')).toBe('/elsewhere/pad.wav');
    expect(projectRelative('/p/songs', '/p/shared/samples/water.wav')).toBe(
      '/p/shared/samples/water.wav',
    );
  });

  it('keeps the root itself absolute', () => {
    expect(projectRelative('/p', '/p')).toBe('/p');
  });

  it('a sibling whose name merely extends the root is not inside it', () => {
    // The case that makes `relative()` the right tool rather than a
    // prefix test — the same trap homeRelative has, where /Users/justinx
    // must not become ~x. Every other case in this block would still
    // pass if someone "simplified" this into path.startsWith(root)
    // (#42 review).
    expect(projectRelative('/tmp/proj', '/tmp/projx/out.wav')).toBe('/tmp/projx/out.wav');
  });

  it('a name beginning with two dots is inside the root, not outside it', () => {
    expect(projectRelative('/p', '/p/..hidden/out.wav')).toBe('..hidden/out.wav');
  });
});

describe('build', () => {
  it('builds, caches, and rebuilds on parameter change', async () => {
    const { state, runner } = countingRunner();

    const first = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(1);
    const target = first.find((o) => o.label.endsWith(':pad-eq'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);

    const second = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(1); // action-cache hit, nothing executed
    expect(second.find((o) => o.label.endsWith(':pad-eq'))!.cached).toBe(true);

    writeTrack('pad-eq', eqTrackYaml(400));
    await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(2); // key changed, rule re-ran
  });

  it('committed outcomes name their file path (#35 review)', async () => {
    const { runner } = countingRunner();
    const outcomes = await buildLabels(root, ['//songs/creek/asset:pad'], runner);
    // Every outcome names a playable path — watch hands any label's fresh
    // artifact to the daemon, including committed content.
    expect(outcomes[0]!.outputPath!.endsWith('songs/creek/audio/pad/pad.wav')).toBe(true);
    // ...and says the path is a source it never produced, which `cached`
    // alone cannot distinguish from a cache hit.
    expect(outcomes[0]!.committed).toBe(true);
  });

  it('a rule outcome is never marked committed', async () => {
    const { runner } = countingRunner();
    const outcomes = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    const rule = outcomes.find((o) => o.label.endsWith(':pad-eq'))!;
    expect(rule.committed).toBeUndefined();
    expect(rule.outputPath!).toContain('.field/out'); // materialized, not committed
  });

  it('materializes by rename, never in place (watch.md §1.6)', async () => {
    const { runner } = countingRunner();
    const first = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    const out = first.find((o) => o.label.endsWith(':pad-eq'))!.outputPath!;
    const before = statSync(out).ino;

    // Under watch the daemon streams the previous artifact from this very
    // path; a rebuild must land on a fresh inode so an open reader keeps
    // its bytes — an in-place copy would truncate under it.
    writeTrack('pad-eq', eqTrackYaml(400));
    await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(statSync(out).ino).not.toBe(before);
  });

  it('expands wildcards, including the everything pattern', async () => {
    const { state, runner } = countingRunner();
    const outcomes = await buildLabels(root, ['//songs/...'], runner);
    // `track:main` is the scaffolded output track — empty, and a stem of
    // silence rather than no stem, so it is a buildable label like any
    // other.
    expect(outcomes.map((o) => o.label).sort()).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/track:main',
      '//songs/creek/track:pad-eq',
    ]);
    expect(state.runs).toBe(2);
    const everything = await buildLabels(root, ['//...'], runner);
    expect(everything).toHaveLength(3);
  });

  it('reserves "all" as a name', async () => {
    const src = join(root, '..', `field-build-all-${Math.random()}.wav`);
    writeWav(src);
    await expect(importAsset(root, 'creek', src, 'all')).rejects.toThrow('reserved');
    rmSync(src);
    // Hand-written YAML is caught by the schema.
    writeTrack('all', eqTrackYaml(700).replace('name: pad-eq', 'name: all'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('reserved');
  });

  it('refuses to build an invalid project', async () => {
    writeTrack('pad-eq', eqTrackYaml(700).replace('audio: pad', 'audio: ghost'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('unknown audio');
  });

  it('errors on unmatched patterns and unknown labels', async () => {
    await expect(buildLabels(root, ['//nowhere/...'])).rejects.toThrow('matched no labels');
    expect(() => queryDeps(root, 'deps(//songs/creek/track:ghost)')).toThrow('no such label');
  });

  it('names the command that fills a takeless request rather than denying it exists', async () => {
    // `check` passes on a request with no takes (bloom-in-tree.md §3), so
    // building is where it has to be refused — and "no such label" would
    // be false in the most expensive way, sending someone to hunt for a
    // typo in a name that is spelled correctly and sitting on disk.
    writeTrack('topline', 'name: topline\ninputs:\n  - generative:\n      text: the water knows the way\n');
    await expect(buildLabels(root, ['//songs/creek/gen:topline'])).rejects.toThrow(
      /has no takes yet\n\n# Use this command to generate\. Specify a seed with --seed <n>\nfield generate creek\/topline$/,
    );
    // The same answer when it is reached as somebody else's dependency,
    // which is how a project actually hits this. Different code path:
    // naming a label expands it as a pattern, depending on one resolves
    // it, and only the second went through resolveLabel.
    expect(() => queryDeps(root, 'deps(//songs/creek/gen:topline)')).toThrow('has no takes yet');

    // A pattern is a request for a set, so it answers with the set — in
    // a song whose requests are all takeless, which is a fresh clone of
    // an example project before anyone has generated anything.
    createSong(root, 'tall-grass');
    mkdirSync(join(root, 'songs/tall-grass/tracks'), { recursive: true });
    for (const [name, line] of [
      ['topline', 'the water knows the way'],
      ['bridge', 'and back again'],
    ]) {
      writeFileSync(
        join(root, `songs/tall-grass/tracks/${name}.yaml`),
        `name: ${name}\ninputs:\n  - generative:\n      text: ${line}\n`,
      );
    }
    await expect(buildLabels(root, ['//songs/tall-grass/gen/...'])).rejects.toThrow(
      /2 generative requests with no takes yet\n\n# Use these commands to generate\.[\s\S]*\nfield generate tall-grass\/bridge\nfield generate tall-grass\/topline/,
    );

    // And the answer a *consumer* gets is the whole list, not the first
    // pending dependency the walk happened to meet: peeling them one
    // play at a time means generating, waiting, and being told about
    // the next one (#118-era session finding).
    writeFileSync(
      join(root, 'songs/tall-grass/tracks/main.yaml'),
      [
        'name: main',
        'inputs:',
        '  - track: topline',
        '  - track: bridge',
        '    at: [3]',
        '',
      ].join('\n'),
    );
    await expect(buildLabels(root, ['//songs/tall-grass/track:main'])).rejects.toThrow(
      /2 generative requests have no takes yet\n\n# Use these commands to generate\.[\s\S]*\nfield generate tall-grass\/bridge\nfield generate tall-grass\/topline/,
    );

    // Across *independent* roots too: a queue of targets, each with its
    // own takeless leaf, is still one session and gets one list — the
    // per-target aggregate alone re-created the peel at the queue level
    // (Codex on #119).
    writeFileSync(
      join(root, 'songs/tall-grass/tracks/verse.yaml'),
      ['name: verse', 'inputs:', '  - track: topline', ''].join('\n'),
    );
    writeFileSync(
      join(root, 'songs/tall-grass/tracks/chorus.yaml'),
      ['name: chorus', 'inputs:', '  - track: bridge', ''].join('\n'),
    );
    await expect(
      buildLabels(root, ['//songs/tall-grass/track:verse', '//songs/tall-grass/track:chorus']),
    ).rejects.toThrow(
      /2 generative requests have no takes yet[\s\S]*\nfield generate tall-grass\/bridge\nfield generate tall-grass\/topline/,
    );

    // Same *name* in two songs — reachable exactly since the walk took
    // many starts, which may span songs. A name comparator meets two
    // equal keys and its order collapses to walk order; the label is
    // unique by construction, so sorting on it holds whichever way the
    // arguments arrive (minjudd on #119).
    createSong(root, 'alpha');
    mkdirSync(join(root, 'songs/alpha/tracks'), { recursive: true });
    writeFileSync(
      join(root, 'songs/alpha/tracks/bridge.yaml'),
      'name: bridge\ninputs:\n  - generative:\n      text: over the water\n',
    );
    writeFileSync(
      join(root, 'songs/alpha/tracks/carrier.yaml'),
      ['name: carrier', 'inputs:', '  - track: bridge', ''].join('\n'),
    );
    const bothWays = [
      ['//songs/alpha/track:carrier', '//songs/tall-grass/track:chorus'],
      ['//songs/tall-grass/track:chorus', '//songs/alpha/track:carrier'],
    ];
    for (const order of bothWays) {
      await expect(buildLabels(root, order)).rejects.toThrow(
        /\nfield generate alpha\/bridge\nfield generate tall-grass\/bridge/,
      );
    }
  });

  it('points at the singular when someone types the old plural package', async () => {
    // Packages went singular; fingers and old docs still type the plural,
    // and "no such label" is a bad way to find that out. The suggestion
    // keeps the shape it was given — correcting the package but handing
    // back a different shape would also not work (#41 review).
    await expect(buildLabels(root, ['//songs/creek/tracks:pad-eq'])).rejects.toThrow(
      'try //songs/creek/track:pad-eq',
    );
    await expect(buildLabels(root, ['//songs/creek/tracks/...'])).rejects.toThrow(
      'try //songs/creek/track/...',
    );
    await expect(buildLabels(root, ['//songs/creek/tracks:all'])).rejects.toThrow(
      'try //songs/creek/track:all',
    );
    expect(() => queryDeps(root, 'deps(//songs/creek/assets:pad)')).toThrow(
      'try //songs/creek/asset:pad',
    );
    // Only when the singular actually exists — no guessing at a package
    // this project does not have. A song that is not here has no `track`
    // package, so the mixes:→track: mapping has nothing to suggest and the
    // error stays bare. (creek itself now always has one: `field song
    // create` scaffolds the output track.)
    await expect(buildLabels(root, ['//songs/ghost/mixes:main'])).rejects.toThrow(
      /matched no labels: \/\/songs\/ghost\/mixes:main$/,
    );
  });

  it('refuses to build when input bytes disagree with the declaration', async () => {
    const { state, runner } = countingRunner();
    const assetPath = join(root, 'songs/creek/audio/pad/pad.wav');
    const original = readFileSync(assetPath);
    writeFileSync(assetPath, Buffer.concat([original, Buffer.from([0, 0])]));
    await expect(
      buildLabels(root, ['//songs/creek/track:pad-eq'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0); // nothing executed, nothing cached

    // Same-size tamper is caught by the hash, not the size.
    writeFileSync(assetPath, Buffer.from(original.map((b, i) => (i === 50 ? b ^ 0xff : b))));
    await expect(
      buildLabels(root, ['//songs/creek/track:pad-eq'], runner),
    ).rejects.toThrow('refusing to build');
    expect(state.runs).toBe(0);

    // Restore the declared bytes and the build proceeds.
    writeFileSync(assetPath, original);
    const outcomes = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(1);
    expect(outcomes.find((o) => o.label.endsWith(':pad-eq'))!.cached).toBe(false);
  });

  it('treats a corrupt action entry as a cache miss and repairs it', async () => {
    const { state, runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(1);

    const actionsDir = join(root, '.field/cache/actions');
    const entry = readdirSync(actionsDir).find((f) => f.endsWith('.json'))!;
    writeFileSync(join(actionsDir, entry), '{"rule": "norm'); // crash mid-write

    const outcomes = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(2); // re-ran instead of crashing
    expect(outcomes.find((o) => o.label.endsWith(':pad-eq'))!.cached).toBe(false);

    const again = await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    expect(state.runs).toBe(2); // entry rewritten; cache healthy again
    expect(again.find((o) => o.label.endsWith(':pad-eq'))!.cached).toBe(true);
  });

  it('renders real audio through the daemon', async () => {
    const outcomes = await buildLabels(root, ['//songs/creek/track:pad-eq']);
    const target = outcomes.find((o) => o.label.endsWith(':pad-eq'))!;
    expect(target.cached).toBe(false);
    expect(existsSync(target.outputPath!)).toBe(true);
    // Second build is a cache hit even with the real runner.
    const again = await buildLabels(root, ['//songs/creek/track:pad-eq']);
    expect(again.find((o) => o.label.endsWith(':pad-eq'))!.cached).toBe(true);
  });
});

const scYaml = (seed: number) =>
  [
    'name: texture',
    'inputs:',
    '  - supercollider:',
    '      source: shared/instruments/texture.scd',
    `      seed: ${seed}`,
    '      duration: 0.25',
    '      channels: 1',
    '',
  ].join('\n');

describe('supercollider', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// fake program v1\n');
    writeTrack('texture', scYaml(42));
  });

  it('builds, caches, and rebuilds when seed or program change', async () => {
    const { state, runner } = countingRunner();
    const label = '//songs/creek/gen:texture';

    const first = await buildLabels(root, [label], runner);
    expect(state.runs).toBe(1);
    expect(first[0]!.cached).toBe(false);

    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(1); // cache hit

    writeTrack('texture', scYaml(43));
    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(2); // seed is a parameter

    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// fake program v2\n');
    await buildLabels(root, [label], runner);
    expect(state.runs).toBe(3); // program content is an input
  });

  it('has no graph deps but shows the program as an explain input', async () => {
    expect(queryDeps(root, 'deps(//songs/creek/gen:texture)')).toEqual([
      '//songs/creek/gen:texture',
    ]);
    const e = await explainLabel(root, '//songs/creek/gen:texture');
    expect(e.rule).toBe('supercollider');
    expect(e.inputs).toHaveLength(1);
    expect(e.inputs[0]!.label).toBe('shared/instruments/texture.scd');
    expect(e.parameters).toEqual({ seed: 42, duration: 0.25, channels: 1 });
  });

  it('rejects missing and escaping program paths', async () => {
    writeTrack('texture', scYaml(42).replace('shared/instruments/texture.scd', 'shared/instruments/ghost.scd'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('not found');

    writeTrack('texture', scYaml(42).replace('shared/instruments/texture.scd', '../outside.scd'));
    await expect(buildLabels(root, ['//songs/...'])).rejects.toThrow('escapes the project');
  });
});

describe('runScProgram edges (no sclang needed)', () => {
  const scratch = () => join(root, '.field');
  const params = { seed: 1, duration: 0.1, channels: 1 as const, sampleRate: 48000 };

  const withSclang = async (binary: string, fn: () => Promise<void>) => {
    const prev = process.env['FIELD_SCLANG'];
    process.env['FIELD_SCLANG'] = binary;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env['FIELD_SCLANG'];
      else process.env['FIELD_SCLANG'] = prev;
    }
  };

  it('errors hard when FIELD_SCLANG points at a missing binary', async () => {
    await withSclang('/nonexistent/sclang-determinism-wrapper', async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), params),
      ).rejects.toThrow('FIELD_SCLANG points at a missing binary');
    });
  });

  // The next two fake sclang with #!/bin/sh scripts. The code path they
  // exercise (execFile, the timeout, stdout capture) is platform-
  // independent; the *stub* is not — Windows has no shebang — so they
  // skip there rather than growing a second stub dialect. A real
  // sclang.exe goes through the same spawn untouched.
  it.skipIf(process.platform === 'win32')('diagnoses a timeout as a missing 0.exit, not a generic failure', async () => {
    const hang = join(root, 'hang.sh');
    writeFileSync(hang, '#!/bin/sh\nsleep 5\n');
    chmodSync(hang, 0o755);
    await withSclang(hang, async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), { ...params, timeoutMs: 300 }),
      ).rejects.toThrow('0.exit');
    });
  });

  it.skipIf(process.platform === 'win32')('surfaces sclang stdout in failures (where SC prints its errors)', async () => {
    const fail = join(root, 'fail.sh');
    writeFileSync(fail, '#!/bin/sh\necho "ERROR: Class not defined: Blah"\necho "boring stderr" >&2\nexit 1\n');
    chmodSync(fail, 0o755);
    await withSclang(fail, async () => {
      await expect(
        runScProgram(join(root, 'x.scd'), join(scratch(), 'out.wav'), params),
      ).rejects.toThrow('Class not defined: Blah');
    });
  });

  it('refuses to cache when the program changes during the render', async () => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), '// v1\n');
    writeTrack('texture', scYaml(42));
    const midRenderEdit: GeneratorRunner = async (_node, _inputPath, outputPath) => {
      writeFileSync(join(root, 'shared/instruments/texture.scd'), '// edited mid-render\n');
      writeFileSync(outputPath, 'audio');
    };
    await expect(
      buildLabels(root, ['//songs/creek/gen:texture'], midRenderEdit),
    ).rejects.toThrow('changed during the render');

    // Nothing was cached: the next build executes again.
    const { state, runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/gen:texture'], runner);
    expect(state.runs).toBe(1);
  });
});

const sclangPresent =
  existsSync('/Applications/SuperCollider.app/Contents/MacOS/sclang') ||
  (process.env['PATH'] ?? '').split(':').some((p) => p !== '' && existsSync(join(p, 'sclang')));

describe.skipIf(!sclangPresent)('sc-render integration (requires sclang)', () => {
  const SC_PROGRAM = `(
var seed = "FIELD_SEED".getenv.asInteger;
var dur = "FIELD_DURATION".getenv.asFloat;
var rate = "FIELD_SAMPLE_RATE".getenv.asInteger;
var out = "FIELD_OUTPUT".getenv;
var chans = "FIELD_CHANNELS".getenv.asInteger;
var freq, score;
thisThread.randSeed = seed;
freq = rrand(200.0, 800.0);
SynthDef(\\fieldTestTone, { |freq = 440|
	var env = EnvGen.kr(Env.linen(0.01, dur - 0.02, 0.01), doneAction: 2);
	Out.ar(0, (SinOsc.ar(freq) * 0.2 * env) ! chans);
}).store;
score = Score([
	[0.0, Synth.basicNew(\\fieldTestTone).newMsg(args: [\\freq, freq])],
	[dur, [0]]
]);
score.recordNRT(
	outputFilePath: out,
	sampleRate: rate,
	headerFormat: "WAV",
	sampleFormat: "int16",
	options: ServerOptions.new.numOutputBusChannels_(chans),
	duration: dur,
	action: { 0.exit }
);
)
`;

  it('renders a seeded tone deterministically through real sclang', { timeout: 120_000 }, async () => {
    writeFileSync(join(root, 'shared/instruments/texture.scd'), SC_PROGRAM);
    writeTrack('texture', scYaml(42));
    const label = '//songs/creek/gen:texture';

    const first = await buildLabels(root, [label]);
    expect(first[0]!.cached).toBe(false);
    expect(existsSync(first[0]!.outputPath!)).toBe(true);
    expect(readFileSync(first[0]!.outputPath!).length).toBeGreaterThan(1000);

    const again = await buildLabels(root, [label]);
    expect(again[0]!.cached).toBe(true);

    // Same seed, wiped cache: the render is reproducible bit-for-bit.
    rmSync(join(root, '.field/cache'), { recursive: true, force: true });
    const rebuilt = await buildLabels(root, [label]);
    expect(rebuilt[0]!.cached).toBe(false);
    expect(rebuilt[0]!.sha256).toBe(first[0]!.sha256);
  });
});

describe('play resolution', () => {
  it('resolves assets to files and rule targets to built outputs, deduped', async () => {
    const { state, runner } = countingRunner();
    const items = await resolvePlayables(
      root,
      ['//songs/creek/asset:pad', '//songs/creek/track:pad-eq', '//songs/creek/asset:pad'],
      runner,
    );
    expect(items.map((i) => i.label)).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/track:pad-eq',
    ]);
    expect(items[0]!.path).toBe(join(root, 'songs/creek/audio/pad/pad.wav'));
    expect(existsSync(items[1]!.path)).toBe(true);
    expect(state.runs).toBe(1); // the rule target was built
  });
});

describe('query and explain', () => {
  it('lists deps in dependency order', () => {
    expect(queryDeps(root, 'deps(//songs/creek/track:pad-eq)')).toEqual([
      '//songs/creek/asset:pad',
      '//songs/creek/track:pad-eq',
    ]);
  });

  it('lists pattern matches', () => {
    expect(queryDeps(root, '//songs/creek/asset:all')).toEqual(['//songs/creek/asset:pad']);
  });

  it('explains a rule target', async () => {
    const before = await explainLabel(root, '//songs/creek/track:pad-eq');
    expect(before.rule).toBe('stem');
    expect(before.cached).toBe(false);
    expect(before.parameters!['inserts']).toEqual([
      {
        effect: 'eq',
        bands: [{ type: 'lowpass', frequency: 700, gain_db: 0, bandwidth: 2 }],
        normalize: true,
      },
    ]);
    expect(before.inputs[0]!.label).toBe('//songs/creek/asset:pad');

    const { runner } = countingRunner();
    await buildLabels(root, ['//songs/creek/track:pad-eq'], runner);
    const after = await explainLabel(root, '//songs/creek/track:pad-eq');
    expect(after.cached).toBe(true);
    expect(after.actionKey).toBe(before.actionKey);
    expect(after.outputs).toHaveLength(1);
  });
});

describe('build cancellation (realtime.md chunk 4)', () => {
  it('the signal reaches the runner, and an aborted one stops the walk', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const observing: GeneratorRunner = async (node, inputPaths, outputPath, ctx) => {
      seen.push(ctx.signal);
      if (inputPaths.length > 0) copyFileSync(inputPaths[0]!, outputPath);
      else writeFileSync(outputPath, `out:${node.label.name}`);
    };
    const live = new AbortController();
    await buildLabels(root, ['//songs/creek/track:pad-eq'], observing, undefined, live.signal);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === live.signal)).toBe(true);

    // Aborted before the walk: nothing runs — the background freeze's
    // ctrl-c must not keep rendering (realtime.md chunk 4). The moved
    // frequency mints a fresh action key, so a run would execute.
    writeTrack('pad-eq', eqTrackYaml(900));
    const aborted = new AbortController();
    aborted.abort();
    let ran = 0;
    const counting: GeneratorRunner = async () => {
      ran++;
    };
    await expect(
      buildLabels(root, ['//songs/creek/track:pad-eq'], counting, undefined, aborted.signal),
    ).rejects.toThrow('build aborted');
    expect(ran).toBe(0);
  });
});
