#!/usr/bin/env node
import { Command } from 'commander';
import { check } from './commands/check.js';
import { createSong, createTrack } from './commands/create.js';
import { fmt } from './commands/fmt.js';
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
  .command('check')
  .description('validate schemas, references, and formatting')
  .action(() => {
    const result = check(requireRoot());
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

program.parse();
