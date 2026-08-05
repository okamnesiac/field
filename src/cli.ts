#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import { parseChannels, parseDurationSeconds, parseSeed } from './cliParsers.js';
import { buildTargets, explainTarget, queryDeps } from './commands/build.js';
import { resolvePlayables } from './commands/play.js';
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

program
  .command('play <patterns...>')
  .description('build targets if needed, then audition them in order (afplay; ctrl-c stops)')
  .action(async (patterns: string[]) => {
    try {
      const items = await resolvePlayables(requireRoot(), patterns);
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
        process.stdout.write(`input: ${input.label} ${input.sha256.slice(0, 12)}\n`);
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
