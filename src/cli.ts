#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import { parseChannels, parseDurationSeconds, parseSeed } from './cliParsers.js';
import { buildTargets, explainTarget, queryDeps } from './commands/build.js';
import { playThroughDaemon, resolvePlayables, type Playable } from './commands/play.js';
import {
  transportCommand,
  transportLocate,
  transportStatusLines,
} from './commands/transport.js';
import { check } from './commands/check.js';
import { runScProgram } from './rules/sc-render.js';
import { createSong, createTrack } from './commands/create.js';
import { fmt } from './commands/fmt.js';
import { importAsset } from './commands/import.js';
import { init } from './commands/init.js';
import { findProjectRoot, loadProject } from './model/project.js';

const program = new Command();

function requireRoot(): string {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a Bloom project (no bloom.yaml found)\n');
    process.exit(1);
  }
  return root;
}

function fail(err: unknown): never {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

program
  .name('bloom')
  .description('Git-native, agent-operable music production')
  .version('0.1.0');

program
  .command('init')
  .description('initialize a Bloom project in the current directory')
  .option('--name <slug>', 'project name (defaults to the directory name)')
  .option('--sample-rate <hz>', 'project sample rate', (v) => Number(v))
  .action((opts: { name?: string; sampleRate?: number }) => {
    try {
      const root = init({ dir: process.cwd(), ...opts });
      process.stdout.write(`initialized Bloom project at ${root}\n`);
    } catch (err) {
      fail(err);
    }
  });

const sc = program.command('sc').description('SuperCollider');
sc.command('render <program>')
  .description('render an SC program directly (uncached, for iteration; commit it as a target for builds)')
  .requiredOption('--seed <n>', 'random seed', parseSeed)
  .requiredOption('--duration <seconds>', 'render length in seconds', parseDurationSeconds)
  .option('--channels <n>', '1 or 2', parseChannels, 2)
  .option('--output <path>', 'output WAV path (defaults to <program>.wav in the current directory)')
  .action(async (programPath: string, opts: { seed: number; duration: number; channels: number; output?: string }) => {
    try {
      const root = findProjectRoot(process.cwd());
      const project = root ? loadProject(root) : undefined;
      const sampleRate = project?.manifest?.data.sample_rate ?? 48000;
      const output = resolve(opts.output ?? `${basename(programPath, extname(programPath))}.wav`);
      await runScProgram(resolve(programPath), output, {
        seed: opts.seed,
        duration: opts.duration,
        channels: opts.channels,
        sampleRate,
      });
      if (!existsSync(output)) {
        throw new Error('sc program exited without writing BLOOM_OUTPUT');
      }
      process.stdout.write(`rendered ${output} (seed ${opts.seed}, ${opts.duration}s @ ${sampleRate} Hz)\n`);
    } catch (err) {
      fail(err);
    }
  });

const ace = program.command('ace').description('ACE-Step generation (outputs are committed, not cached)');
ace
  .command('setup')
  .description('set up the bloom-aced Python environment (uv; explicit, never automatic)')
  .action(async () => {
    try {
      const { aceSetup } = await import('./commands/ace.js');
      await aceSetup((line) => process.stdout.write(`${line}\n`));
    } catch (err) {
      fail(err);
    }
  });
ace
  .command('generate <name>')
  .description('generate variants into songs/<song>/generation/<name>/ with a provenance recipe')
  .requiredOption('--song <name>', 'song whose tempo map projects musical time')
  .requiredOption('--prompt <text>', 'what to generate')
  .requiredOption('--seed <n>', 'base seed; variant i uses seed+i', parseSeed)
  .option('--bars <n>', 'length in bars at the song tempo (or use --duration)', (v) => Number(v))
  .option('--duration <seconds>', 'length in seconds (or use --bars)', (v) => Number(v))
  .option('--variants <n>', 'how many variants (1-8)', (v) => Number(v), 2)
  .option('--lyrics <text>', 'lyrics (omit for instrumental)')
  .option('--bpm <n>', 'override the tempo-map bpm hint', (v) => Number(v))
  .action(async (name: string, opts: {
    song: string; prompt: string; seed: number; bars?: number; duration?: number;
    variants: number; lyrics?: string; bpm?: number;
  }) => {
    try {
      const { aceGenerate } = await import('./commands/ace.js');
      const result = await aceGenerate(requireRoot(), name, {
        song: opts.song,
        prompt: opts.prompt,
        seed: opts.seed,
        bars: opts.bars,
        durationSeconds: opts.duration,
        variants: opts.variants,
        lyrics: opts.lyrics,
        bpm: opts.bpm,
        onProgress: (stage) => process.stdout.write(`… ${stage}\n`),
      });
      process.stdout.write(
        `generated ${result.files.length} variants (${result.durationSeconds.toFixed(1)}s` +
          `${result.bpm !== undefined ? ` @ ${result.bpm} bpm` : ''}, ${result.model})\n`,
      );
      for (const file of result.files) process.stdout.write(`  ${file}\n`);
      process.stdout.write(`recipe: ${result.recipePath}\n`);
      process.stdout.write(`audition: afplay ${result.files[0]}\n`);
    } catch (err) {
      fail(err);
    }
  });

const song = program.command('song').description('manage songs');
song
  .command('create <name>')
  .description('create a song with default tempo and meter')
  .action((name: string) => {
    try {
      const dir = createSong(requireRoot(), name);
      process.stdout.write(`created ${dir}\n`);
    } catch (err) {
      fail(err);
    }
  });

const track = program.command('track').description('manage tracks');
track
  .command('create <song> <name>')
  .description('create a track in a song')
  .option('--type <type>', 'audio | midi', 'audio')
  .action((songName: string, name: string, opts: { type: string }) => {
    try {
      if (opts.type !== 'audio' && opts.type !== 'midi') {
        throw new Error(`unknown track type "${opts.type}"`);
      }
      const path = createTrack(requireRoot(), songName, name, opts.type);
      process.stdout.write(`created ${path}\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('import <file>')
  .description('copy an audio file into a song and record it in assets.yaml')
  .requiredOption('--song <name>', 'song to import into')
  .option('--name <slug>', 'asset name (defaults to the slugified filename)')
  .action(async (file: string, opts: { song: string; name?: string }) => {
    try {
      const result = await importAsset(requireRoot(), opts.song, file, opts.name);
      process.stdout.write(`imported ${result.name} (${result.file}, ${result.bytes} bytes)\n`);
      process.stdout.write(`sha256 ${result.sha256}\n`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command('build <patterns...>')
  .description('build targets (//songs/creek/targets:pad-96k, //songs/..., :all)')
  .action(async (patterns: string[]) => {
    try {
      const outcomes = await buildTargets(requireRoot(), patterns);
      for (const o of outcomes) {
        const status = o.cached ? 'cached' : 'built';
        const where = o.outputPath ? ` → ${o.outputPath}` : '';
        process.stdout.write(`${status}  ${o.label}${where}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

// The retiring fallback for machines without the built daemon: playback
// through afplay, no transport, no --from.
async function playWithAfplay(items: Playable[]): Promise<void> {
  for (const item of items) {
    process.stdout.write(`playing ${item.label}\n`);
    const interrupted = await new Promise<boolean>((done, reject) => {
      const child = spawn('afplay', [item.path], { stdio: 'inherit' });
      child.on('error', (err) => reject(new Error(`afplay failed: ${err.message}`)));
      child.on('exit', (code, signal) => {
        if (signal !== null) return done(true); // ctrl-c: stop the queue
        if (code !== 0) return reject(new Error(`afplay exited ${code} for ${item.path}`));
        done(false);
      });
    });
    if (interrupted) break;
  }
}

program
  .command('play <patterns...>')
  .description('build targets if needed, then audition them in order (ctrl-c stops)')
  .option('--from <position>', 'start at bar[.beat[.tick]] (single target only)')
  .option('--device <name>', 'output device (bloom devices lists them)')
  .action(async (patterns: string[], opts: { from?: string; device?: string }) => {
    try {
      const root = requireRoot();
      const items = await resolvePlayables(root, patterns);
      const { AudiodClient, daemonBinary } = await import('./audiod/client.js');
      if (!daemonBinary()) {
        if (opts.from !== undefined || opts.device !== undefined) {
          throw new Error('--from and --device need bloom-audiod (pnpm build:native)');
        }
        process.stderr.write('bloom-audiod is not built; using afplay (pnpm build:native)\n');
        await playWithAfplay(items);
        return;
      }

      let interrupted = false;
      process.once('SIGINT', () => {
        // Stop the daemon's transport from a second connection — the
        // blocking play then sees 'stopped' and winds down the queue.
        interrupted = true;
        void (async () => {
          try {
            const c = await AudiodClient.connect(root, { spawnIfNeeded: false });
            await c.stop();
            c.close();
          } catch {
            // daemon already gone
          }
        })();
      });

      const project = loadProject(root);
      const tty = process.stdout.isTTY === true;
      let onPositionLine = false;
      await playThroughDaemon(root, project, items, opts, {
        onItem: (label, note) => {
          if (onPositionLine) process.stdout.write('\n');
          onPositionLine = false;
          process.stdout.write(`playing ${label}${note}\n`);
        },
        onPosition: (line) => {
          if (tty) {
            process.stdout.write(`\r  ${line}   `);
            onPositionLine = true;
          }
        },
        onDevice: (name) => {
          if (onPositionLine) process.stdout.write('\n');
          onPositionLine = false;
          process.stdout.write(`→ output moved to ${name}\n`);
        },
        interrupted: () => interrupted,
      });
      if (onPositionLine) process.stdout.write('\n');
    } catch (err) {
      fail(err);
    }
  });

const transport = program
  .command('transport')
  .description('control the running daemon (bloom play starts it)');
transport
  .command('status')
  .description('state, position, file, and device')
  .action(async () => {
    try {
      const root = requireRoot();
      for (const line of await transportStatusLines(root, loadProject(root))) {
        process.stdout.write(`${line}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });
transport
  .command('locate <position>')
  .description('jump to bar[.beat[.tick]] in the loaded file')
  .action(async (position: string) => {
    try {
      const root = requireRoot();
      process.stdout.write(`${await transportLocate(root, loadProject(root), position)}\n`);
    } catch (err) {
      fail(err);
    }
  });
for (const op of ['play', 'pause', 'stop'] as const) {
  transport
    .command(op)
    .description(`${op} the transport`)
    .action(async () => {
      try {
        await transportCommand(requireRoot(), op);
      } catch (err) {
        fail(err);
      }
    });
}

program
  .command('devices')
  .description('list output devices via bloom-audiod (spawns it if needed)')
  .action(async () => {
    try {
      const { AudiodClient } = await import('./audiod/client.js');
      const client = await AudiodClient.connect(requireRoot());
      const result = await client.devices();
      client.close();
      if (result.null_output) {
        process.stdout.write('daemon is in null-output mode (no devices)\n');
        return;
      }
      for (const device of result.devices) {
        process.stdout.write(`${device.default ? '* ' : '  '}${device.name}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('query <expr>')
  .description("query the graph: a pattern, or deps(//songs/creek/targets:pad-96k)")
  .action((expr: string) => {
    try {
      for (const label of queryDeps(requireRoot(), expr)) {
        process.stdout.write(`${label}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('explain <label>')
  .description('show a target\'s rule, inputs, action key, and cache status')
  .action(async (label: string) => {
    try {
      const e = await explainTarget(requireRoot(), label);
      process.stdout.write(`${e.label} (${e.kind})\n`);
      if (e.rule) process.stdout.write(`rule: ${e.rule} v${e.ruleVersion}\n`);
      for (const input of e.inputs) {
        const sha = input.sha256 ? input.sha256.slice(0, 12) : '(not built)';
        process.stdout.write(`input: ${input.label} ${sha}\n`);
      }
      if (e.parameters && Object.keys(e.parameters).length > 0) {
        process.stdout.write(`parameters: ${JSON.stringify(e.parameters)}\n`);
      }
      if (e.actionKey) {
        process.stdout.write(`action: ${e.actionKey.slice(0, 12)} (${e.cached ? 'cached' : 'not cached'})\n`);
      }
      for (const out of e.outputs ?? []) {
        process.stdout.write(`output: ${out.sha256.slice(0, 12)} (${out.bytes} bytes)\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command('check')
  .description('validate schemas, references, asset content, and formatting')
  .action(async () => {
    let result;
    try {
      result = await check(requireRoot());
    } catch (err) {
      fail(err);
    }
    for (const d of result.diagnostics) {
      process.stdout.write(`${d.file}: ${d.message}\n`);
    }
    for (const f of result.unformatted) {
      process.stdout.write(`${f}: not canonically formatted (run bloom fmt)\n`);
    }
    if (result.ok) process.stdout.write('ok\n');
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('fmt')
  .description('rewrite project files to canonical formatting')
  .action(() => {
    const result = fmt(requireRoot());
    if (result.errors.length > 0) {
      for (const e of result.errors) process.stderr.write(`${e}\n`);
      process.stderr.write('fix validation errors before formatting\n');
      process.exit(1);
    }
    for (const f of result.formatted) process.stdout.write(`formatted ${f}\n`);
    if (result.formatted.length === 0) process.stdout.write('already canonical\n');
  });

program
  .command('status')
  .description('summarize the project')
  .action(() => {
    const root = requireRoot();
    const project = loadProject(root);
    const name = project.manifest?.data.name ?? '(invalid manifest)';
    const rate = project.manifest?.data.sample_rate;
    process.stdout.write(`project ${name}${rate ? ` @ ${rate} Hz` : ''}\n`);
    for (const song of project.songs) {
      const clips = song.tracks.reduce((n, t) => n + t.data.clips.length, 0);
      process.stdout.write(
        `  ${song.name}: ${song.tracks.length} tracks, ${clips} clips, ${song.takes.length} takes\n`,
      );
    }
    if (project.diagnostics.length > 0) {
      process.stdout.write(`${project.diagnostics.length} problems (run bloom check)\n`);
    }
  });

await program.parseAsync();
