#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  drawSeed,
  formatSeeds,
  parseBars,
  parseGenTarget,
  parseBpm,
  parseChannels,
  parseConviction,
  parseDurationSeconds,
  parseExaggeration,
  parseExportBitDepth,
  parseExportRate,
  parseSeed,
  parseVariantNumber,
  parseVariants,
  wantsVersion,
} from './cliParsers.js';
import { buildLabels, explainLabel, projectRelative, queryDeps } from './commands/build.js';
import { formatReach, rootNote } from './model/levels.js';
import { formatCable } from './model/cables.js';
import { playThroughDaemon, resolvePlayables, type Playable } from './commands/play.js';
import {
  transportCommand,
  transportLocate,
  transportStatusLines,
} from './commands/transport.js';
import { check } from './commands/check.js';
import { runScProgram } from './generators/supercollider.js';
import { createSong, createTrack } from './commands/create.js';
import { fmt } from './commands/fmt.js';
import { importAsset } from './commands/import.js';
import { init } from './commands/init.js';
import type { BuildOutcome } from './graph/build.js';
import {
  diagnosticErrors,
  findProjectRoot,
  formatDiagnostic,
  loadProject,
} from './model/project.js';

const program = new Command();

function requireRoot(): string {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    process.stderr.write('not inside a Field project (no field.yaml found)\n');
    process.exit(1);
  }
  return root;
}

function fail(err: unknown): never {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}

program
  .name('field')
  .description('Git-native, agent-operable music production')
  // Declared so it appears in `field --help`, not so commander acts on it —
  // argv is intercepted below. Dropping `.version()` took the flag out of
  // the help text, which left the only remaining way to ask undiscoverable:
  // `field version` errors with no suggestion and `--help` did not mention
  // the flag, so a change called "one way" shipped zero findable ones (#70
  // review). The description earns its place too — `--version` printing a
  // daemon report is not what the flag usually means.
  .option('-V, --version', 'which build this is, and which build each daemon is running');

// `field --version` is the only way to ask. It briefly printed the bare
// number while a `field version` subcommand printed the report, which is
// two commands differing by two dashes and a thing to remember for no
// benefit — and the obvious one gave the least useful answer. `--version`
// is the spelling every CLI has, so it is the one that stays; if a script
// ever needs only the number, the first line still starts with it.
//
// Handled before parse because commander's `.version()` can only print a
// static string, and this has to do real work.
async function printVersion(): Promise<void> {
  const { versionReport, formatVersionReport } = await import('./commands/version.js');
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  process.stdout.write(formatVersionReport(await versionReport(root), root) + '\n');
}

program
  .command('init')
  .description('initialize a Field project in the current directory')
  .option('--name <slug>', 'project name (defaults to the directory name)')
  .option('--sample-rate <hz>', 'project sample rate', (v) => Number(v))
  .action((opts: { name?: string; sampleRate?: number }) => {
    try {
      const root = init({ dir: process.cwd(), ...opts });
      process.stdout.write(`initialized Field project at ${root}\n`);
    } catch (err) {
      fail(err);
    }
  });

const sc = program.command('sc').description('SuperCollider');
sc.command('render <program>')
  .description('render an SC program directly (uncached, for iteration; a supercollider: entry is the cached form)')
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
        throw new Error('sc program exited without writing FIELD_OUTPUT');
      }
      process.stdout.write(`rendered ${output} (seed ${opts.seed}, ${opts.duration}s @ ${sampleRate} Hz)\n`);
    } catch (err) {
      fail(err);
    }
  });

// The deliberate-trigger verbs over the generator category
// (project-layout.md §1.7): the recipe's model field says which generator
// ran, so the verbs carry no model prefix.
program
  .command('setup [worker]')
  .description('set up generation worker environments (uv; explicit, never automatic)')
  .action(async (worker: string | undefined) => {
    try {
      const { setupWorker } = await import('./commands/generate.js');
      await setupWorker((line) => process.stdout.write(`${line}\n`), worker);
    } catch (err) {
      fail(err);
    }
  });
program
  .command('generate <target>')
  .description('run a deliberate generator: fills a generative entry as <song>/<name> (a new name scaffolds a leaf track); variants land in songs/<song>/audio/<name>/')
  .option('--song <name>', 'retired — the song rides in the name (creek/lead-take)')
  .option('--prompt <text>', 'what to generate — music, through field-aced')
  .option('--text <line>', 'the line to speak or sing — voice, through field-voiced')
  .option('--seed <n>', 'base seed; variant i uses seed+i (default: random, recorded per take)', parseSeed)
  .option('--bars <n>', 'music: length in bars at the song tempo (or use --duration)', parseBars)
  .option('--duration <seconds>', 'music: length in seconds (or use --bars)', parseDurationSeconds)
  .option('--variants <n>', 'how many variants (1-8)', parseVariants, 2)
  .option('--lyrics <text>', 'music: lyrics (omit for instrumental)')
  .option('--bpm <n>', 'music: override the tempo-map bpm hint', parseBpm)
  .option('--voice-ref <asset>', "voice: the committed recording that defines the voice (omit for the model's own)")
  .option('--exaggeration <n>', 'voice: expressive intensity, 0.25-2 (lower is calmer and slower)', parseExaggeration)
  .option('--conviction <n>', 'voice: how hard it commits to the on-text reading, 0.1-1 (lower lingers)', parseConviction)
  .action(async (target: string, opts: {
    song?: string; prompt?: string; text?: string; seed?: number; bars?: number; duration?: number;
    variants: number; lyrics?: string; bpm?: number; voiceRef?: string;
    exaggeration?: number; conviction?: number;
  }) => {
    try {
      // The song rides in the name like every other command's labels;
      // the flag survives only to say so, concretely, to fingers and
      // docs that learned the old spelling.
      if (opts.song !== undefined) {
        throw new Error(
          `--song has retired — the song rides in the name: ` +
            `field generate ${opts.song}/${target} …`,
        );
      }
      const { song, name } = parseGenTarget(target, 'generate');
      const { generateVariants } = await import('./commands/generate.js');
      // A seed is provenance, not reproducibility — inference does not
      // reproduce across GPU/framework versions (bloom-in-tree.md §3),
      // and every take records the seed it ran with — so an omitted
      // --seed draws one and the output names it below.
      const seed = opts.seed ?? drawSeed();
      const result = await generateVariants(requireRoot(), name, {
        song,
        prompt: opts.prompt,
        text: opts.text,
        seed,
        bars: opts.bars,
        durationSeconds: opts.duration,
        variants: opts.variants,
        lyrics: opts.lyrics,
        bpm: opts.bpm,
        voiceRef: opts.voiceRef,
        exaggeration: opts.exaggeration,
        conviction: opts.conviction,
        onProgress: (stage) => process.stdout.write(`… ${stage}\n`),
      });
      // A voice line has no requested length to report; what it has is
      // the voice it was generated in, which is either a committed
      // recording or the model's own (voice-generation.md §6).
      const detail =
        result.durationSeconds !== undefined
          ? `${result.durationSeconds.toFixed(1)}s` +
            `${result.bpm !== undefined ? ` @ ${result.bpm} bpm` : ''}, `
          : `voice: ${result.voiceRef ?? "the model's own"}, `;
      process.stdout.write(
        `generated ${result.files.length} variants (${detail}${result.model}, ${formatSeeds(result.seeds)})\n`,
      );
      for (const file of result.files) process.stdout.write(`  ${file}\n`);
      process.stdout.write(`recipe: ${result.recipePath}\n`);
      process.stdout.write(
        `audition: field play //songs/${song}/gen:${name}-1\n` +
          `choose:   field choose //songs/${song}/gen:${name} --variant <n>\n`,
      );
    } catch (err) {
      fail(err);
    }
  });
program
  .command('choose <target>')
  .description("repoint which committed variant a gen node's label resolves to (<song>/<name>)")
  .option('--song <name>', 'retired — the song rides in the name (creek/still-water-keys)')
  .requiredOption('--variant <n>', 'variant number (1-based, as played/numbered)', parseVariantNumber)
  .action(async (target: string, opts: { song?: string; variant: number }) => {
    try {
      if (opts.song !== undefined) {
        throw new Error(
          `--song has retired — the song rides in the name: ` +
            `field choose ${opts.song}/${target} --variant ${opts.variant}`,
        );
      }
      const { song, name } = parseGenTarget(target, 'choose');
      const { chooseVariant } = await import('./commands/generate.js');
      const result = await chooseVariant(requireRoot(), name, {
        song,
        variant: opts.variant,
      });
      const moved = result.previous !== undefined && result.previous !== opts.variant;
      process.stdout.write(
        `${moved ? 'moved' : 'chose'} ${name} → variant ${opts.variant} (${result.file})\n` +
          `//songs/${song}/gen:${name} now plays it; every placement follows\n`,
      );
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
  .action((songName: string, name: string) => {
    try {
      const path = createTrack(requireRoot(), songName, name);
      process.stdout.write(`created ${path}\n`);
    } catch (err) {
      fail(err);
    }
  });

const insert = program.command('insert').description("manage a track's inserts");
insert
  .command('add <track> [plugin]')
  .description('add an insert to a track (interactive chooser when no plugin is named)')
  .option('--at <position>', '1-based chain position for the new insert, or "end"')
  .option('--id <handle>', 'instance id (needed when the chain repeats a plugin)')
  .option('--au', 'prefer the AU when a name matches both formats')
  .option('--vst3', 'prefer the VST3 when a name matches both formats')
  .action(async (trackRef: string, pluginName: string | undefined, opts: { at?: string; id?: string; au?: boolean; vst3?: boolean }) => {
    try {
      if (opts.au === true && opts.vst3 === true) throw new Error('--au and --vst3 are exclusive');
      const { addInsert } = await import('./commands/insert.js');
      // The interactive halves exist exactly where a TTY does; a
      // script gets the recorded non-interactive answers instead
      // (add-insert.md §2) — named plugin required, end position,
      // duplicate case refused.
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
      const hooks = interactive
        ? await (async () => {
            const { runPicker } = await import('./commands/picker.js');
            return {
              choosePlugin: (items: import('./commands/picker.js').PickerItem<import('./audio/plugins.js').PluginInfo>[]) =>
                runPicker('plugin', items),
              choosePosition: (labels: string[], defaultIndex: number) =>
                runPicker(
                  'position',
                  labels.map((label, i) => ({
                    label: i === defaultIndex ? `${label} (default)` : label,
                    search: label.toLowerCase(),
                    value: i,
                  })),
                  // The cursor starts where the label says it does —
                  // bare Enter is the default, not the first row
                  // (Bugbot on #155).
                  defaultIndex,
                ),
              askId: async (prompt: string): Promise<string | undefined> => {
                const { createInterface } = await import('node:readline/promises');
                const rl = createInterface({ input: process.stdin, output: process.stdout });
                try {
                  const answer = await rl.question(`${prompt}: `);
                  return answer.trim() === '' ? undefined : answer.trim();
                } finally {
                  rl.close();
                }
              },
            };
          })()
        : undefined;
      const outcome = await addInsert(requireRoot(), trackRef, {
        ...(pluginName !== undefined ? { plugin: pluginName } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.au === true ? { prefer: 'au' as const } : {}),
        ...(opts.vst3 === true ? { prefer: 'vst3' as const } : {}),
        ...(hooks !== undefined ? { hooks } : {}),
      });
      if (outcome.cancelled === true) {
        process.stdout.write('nothing added\n');
        return;
      }
      const p = outcome.plugin!;
      process.stdout.write(
        `added ${p.name} (${p.format} ${p.identifier} ${p.version}) → ` +
          `${outcome.song}/${outcome.track} position ${outcome.position}/${outcome.chainLength} (${outcome.file})\n`,
      );
      if (outcome.backfilled!.length > 0) {
        process.stdout.write(`ids written on existing instances: ${outcome.backfilled!.join(', ')}\n`);
      }
      // The handoff add-insert.md §5 records: once editor sessions
      // land (plugin-hosting.md chunk 3) this runs field open instead
      // of naming it.
      // outcome.address, not outcome.track: a colliding track name
      // needs its song qualifier here too, or the advertised command
      // cannot identify the insert just added (Codex on #155).
      process.stdout.write(
        `field open ${outcome.address}/${outcome.handle} will open its editor once editor sessions land\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('import <file>')
  .description('copy an audio file into a song and record it (and its WAV facts) in assets.yaml')
  .requiredOption('--song <name>', 'song to import into')
  .option('--name <slug>', 'asset name (defaults to the slugified filename)')
  .option('--allow-mismatch', "import a WAV whose sample rate differs from the project's")
  .action(async (file: string, opts: { song: string; name?: string; allowMismatch?: boolean }) => {
    try {
      // The y/N prompt is the interactive half of decision 5's
      // acknowledgement; scripts pass --allow-mismatch instead.
      const confirmMismatch = process.stdin.isTTY
        ? async (message: string): Promise<boolean> => {
            const { createInterface } = await import('node:readline/promises');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = await rl.question(`${message}\nimport anyway? [y/N] `);
              return answer.trim().toLowerCase() === 'y';
            } finally {
              rl.close();
            }
          }
        : undefined;
      const result = await importAsset(requireRoot(), opts.song, file, opts.name, {
        allowMismatch: opts.allowMismatch,
        confirmMismatch,
      });
      const facts =
        result.header !== undefined
          ? `, ${result.header.sampleRate} Hz ${result.header.bitsPerSample}-bit ` +
            `${result.header.channels}ch, ${result.header.frames} frames`
          : '';
      process.stdout.write(`imported ${result.name} (${result.file}, ${result.bytes} bytes${facts})\n`);
      process.stdout.write(`sha256 ${result.sha256}\n`);
      if (result.headerProblem !== undefined) {
        process.stdout.write(
          `note: WAV header unreadable, nothing recorded — ${result.headerProblem}\n`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// What happened to a label, in one word: a committed source (an asset, a
// chosen variant) was never built at all, so saying `cached` about it
// claims a cache hit that never happened. Padded to a common width so the
// labels line up down the column.
function buildStatus(o: BuildOutcome): string {
  const status = o.committed === true ? 'source' : o.cached ? 'cached' : 'built';
  return status.padEnd(6);
}

program
  .command('build <patterns...>')
  .description('build labels (creek/track:drums, creek/..., or a bare song for its output track)')
  .option('--watch', 'rebuild on project changes until ctrl-c, reporting outputs that audibly moved')
  .action(async (patterns: string[], opts: { watch?: boolean }) => {
    try {
      const root = requireRoot();
      if (opts.watch !== true) {
        const outcomes = await buildLabels(root, patterns, undefined, (line) =>
          process.stdout.write(`check: ${line}\n`),
        );
        for (const o of outcomes) {
          const where = o.outputPath ? ` → ${projectRelative(root, o.outputPath)}` : '';
          process.stdout.write(`${buildStatus(o)}  ${o.label}${where}\n`);
        }
        return;
      }
      // Watch mode (watch.md): the first build is the baseline; every
      // settled change rebuilds and reports labels whose output hash
      // moved. A red project prints its diagnostics and keeps the last
      // good outputs (§1.2) — so unlike a plain build, watch starts fine
      // on a project that doesn't currently check.
      const abort = new AbortController();
      process.once('SIGINT', () => abort.abort());
      let first = true;
      await import('./commands/watch.js').then(({ watchBuild }) =>
        watchBuild(root, patterns, { signal: abort.signal }, {
          onDiagnostics: (lines) => {
            for (const line of lines) process.stdout.write(`check: ${line}\n`);
          },
          onOutcomes: (outcomes, changed) => {
            if (first) {
              first = false;
              for (const o of outcomes) {
                process.stdout.write(`${buildStatus(o)}  ${o.label}\n`);
              }
              process.stdout.write('watching for changes (ctrl-c stops)\n');
              return;
            }
            if (changed.length === 0) {
              process.stdout.write('· no audible change\n');
              return;
            }
            for (const o of changed) {
              process.stdout.write(`↻ ${o.label} ${o.sha256.slice(0, 12)}\n`);
            }
          },
          onError: (err, phase) => process.stdout.write(`${phase} failed: ${err.message}\n`),
        }),
      );
    } catch (err) {
      fail(err);
    }
  });

program
  .command('export <patterns...>')
  .description('build labels and copy the results to ~/Desktop as numbered versions')
  .option('--to <dir>', 'destination directory instead of ~/Desktop (must exist)')
  .option('--rate <hz>', "deliver at this sample rate (default: the source's)", parseExportRate)
  .option('--bit-depth <bits>', "deliver at this bit depth: 16, 24, or 32 (default: the source's; a float source must choose)", parseExportBitDepth)
  .action(async (patterns: string[], opts: { to?: string; rate?: number; bitDepth?: 16 | 24 | 32 }) => {
    try {
      const { exportLabels, homeRelative } = await import('./commands/export.js');
      const results = await exportLabels(requireRoot(), patterns, {
        to: opts.to,
        rate: opts.rate,
        bitDepth: opts.bitDepth,
      });
      for (const r of results) {
        // Three outcomes, one column: a new version, nothing to do, and
        // the one worth stopping on — these bytes are an *older* version,
        // so a change was undone and the newest export is not what you
        // just built. All three words are 8 characters, so the labels
        // line up down the column.
        const reverted = r.unchanged && r.version < r.newest;
        const status = reverted ? 'reverted' : r.unchanged ? 'current ' : 'exported';
        const note = reverted ? ` (v${r.newest} is newer and different)` : '';
        process.stdout.write(`${status} ${r.label} → ${homeRelative(r.to)}${note}\n`);
      }
    } catch (err) {
      fail(err);
    }
  });

// The retiring fallback for machines without the built daemon: playback
// through afplay, no transport, no --from. macOS only, and deliberately
// not replaced elsewhere: since realtime.md, `field play` IS live
// evaluation in the daemon, and a second, worse playback path on the
// platform with the least coverage would be a liability, not a feature
// (windows-portability.md §2.2). Windows fails with the build hint.
async function playWithAfplay(items: Playable[]): Promise<void> {
  if (process.platform !== 'darwin') {
    // afplay is a macOS binary: anywhere else the spawn below could only
    // die with ENOENT naming a tool this machine never had (#162 review
    // caught the docs describing this guard before it was this wide).
    throw new Error(
      'field-audiod is not built, and the afplay fallback is macOS-only — run `pnpm build:native`',
    );
  }
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
  .description('play a song live in the engine, or audition built artifacts in order (ctrl-c stops)')
  .option('--from <position>', 'start at bar[.beat[.tick]] (one song or one artifact)')
  .option('--device <name>', 'output device (field devices lists them)')
  .option('--loop', 'loop the song at its declared extent, or replay an artifact queue')
  .option('--click', 'overlay a metronome (artifacts only; rendered CLI-side, loops with the file)')
  .option('--watch', "follow the project: edits land mid-play (a song's live session)")
  .action(async (patterns: string[], opts: { from?: string; device?: string; loop?: boolean; click?: boolean; watch?: boolean }) => {
    try {
      const root = requireRoot();
      const project = loadProject(root);
      // A bare song name plays live (realtime.md decision 8: since the
      // freeze, live evaluation is what playing a song *is* — clean
      // subgraphs arrive as cached stems, only dirt costs). An explicit
      // label — `creek/track:main`, an asset, several patterns — stays
      // file playback of the built artifact.
      const liveSong =
        patterns.length === 1 && project.songs.find((s) => s.name === patterns[0])
          ? patterns[0]!
          : undefined;
      if (liveSong !== undefined) {
        if (opts.click === true) {
          // The click renders CLI-side over a file, which a live session
          // is not; the artifact spelling still composes with it.
          throw new Error(
            `--click rides file playback: field play ${liveSong}/track:main --click`,
          );
        }
        const { playLiveSession } = await import('./commands/play.js');
        let interrupted = false;
        process.once('SIGINT', () => {
          interrupted = true;
        });
        let onLine = false;
        const liveAbort = new AbortController();
        process.once('SIGINT', () => liveAbort.abort());
        await playLiveSession(
          root,
          project,
          liveSong,
          {
            ...(opts.device !== undefined ? { device: opts.device } : {}),
            ...(opts.from !== undefined ? { from: opts.from } : {}),
            ...(opts.loop === true ? { loop: true } : {}),
            ...(opts.watch === true ? { watch: true, signal: liveAbort.signal } : {}),
          },
          {
            onItem: (label, note) =>
              process.stdout.write(`live    ${label}${note ? `  (${note})` : ''}\n`),
            onPosition: (line) => {
              process.stdout.write(`\r${line}   `);
              onLine = true;
            },
            onReloaded: (note) => {
              if (onLine) process.stdout.write('\n');
              onLine = false;
              process.stdout.write(`edit    ${note}\n`);
            },
            onWatchError: (message) => {
              if (onLine) process.stdout.write('\n');
              onLine = false;
              process.stderr.write(`watch   ${message}\n`);
            },
            interrupted: () => interrupted,
          },
        );
        if (onLine) process.stdout.write('\n');
        return;
      }
      let items = await resolvePlayables(root, patterns);
      const { AudiodClient, daemonBinary } = await import('./audiod/client.js');
      if (!daemonBinary()) {
        if (opts.from !== undefined || opts.device !== undefined || opts.loop === true || opts.click === true || opts.watch === true) {
          throw new Error('--from, --device, --loop, --click, and --watch need field-audiod (pnpm build:native)');
        }
        process.stderr.write('field-audiod is not built; using afplay (pnpm build:native)\n');
        await playWithAfplay(items);
        return;
      }
      if (opts.watch === true) {
        // The loop-wrap takeover retired with the live engine
        // (realtime.md chunk 3): edits land mid-play there, no wrap wait.
        throw new Error("play --watch follows a song's live session: field play <song> --watch");
      }

      const watchAbort = new AbortController();
      let interrupted = false;
      process.once('SIGINT', () => {
        // Stop the daemon's transport from a second connection — the
        // blocking play then sees 'stopped' and winds down the queue.
        interrupted = true;
        watchAbort.abort();
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

      if (opts.click === true) {
        const { applyClick } = await import('./commands/click.js');
        items = applyClick(root, project, items);
      }
      const tty = process.stdout.isTTY === true;
      let onPositionLine = false;
      const say = (line: string): void => {
        if (onPositionLine) process.stdout.write('\n');
        onPositionLine = false;
        process.stdout.write(`${line}\n`);
      };



      await playThroughDaemon(
        root,
        project,
        items,
        opts,
        {
          onItem: (label, note) => say(`playing ${label}${note}`),
          onPosition: (line) => {
            if (tty) {
              process.stdout.write(`\r  ${line}   `);
              onPositionLine = true;
            }
          },
          onDevice: (name) => say(`→ output moved to ${name}`),
          interrupted: () => interrupted,
        },
      );
      if (onPositionLine) process.stdout.write('\n');
    } catch (err) {
      fail(err);
    }
  });

const transport = program
  .command('transport')
  .description('control the running daemon (field play starts it)');
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
for (const op of ['play', 'pause', 'stop', 'quit'] as const) {
  transport
    .command(op)
    .description(
      op === 'quit'
        ? 'shut the daemon down (it respawns on the next play — how to pick up a new build)'
        : `${op} the transport`,
    )
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
  .description('list output devices via field-audiod (spawns it if needed)')
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
  .description("query the graph: a pattern, or deps(creek/track:drums)")
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
  .description('show a label\'s type, inputs, action key, and cache status')
  .action(async (label: string) => {
    try {
      const e = await explainLabel(requireRoot(), label);
      process.stdout.write(`${e.label} (${e.kind})\n`);
      // The CLI speaks the format's language (project-layout.md §4):
      // type, not the engine's rule.
      if (e.rule) process.stdout.write(`type: ${e.rule} v${e.ruleVersion}\n`);
      // "Which variant are we using" is this command's question to
      // answer: the chosen line on the request's own label, the bare
      // file on a per-take audition label.
      if (e.choice) {
        process.stdout.write(
          `chosen: variant ${e.choice.chosen} of ${e.choice.takes} (${e.file})\n`,
        );
      } else if (e.file) {
        process.stdout.write(`file: ${e.file}\n`);
      }
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
      // Where the signal goes, for a track. Last because it is the mix
      // question and everything above it is the build question — and
      // because it is the line someone came here for when a level
      // surprised them (nested-tracks.md §5).
      if (e.levels) {
        if (e.levels.reaches.length === 0) {
          process.stdout.write(`reaches: ${rootNote(e.levels.track)}\n`);
        }
        for (const reach of e.levels.reaches) {
          process.stdout.write(`reaches: ${formatReach(reach)}\n`);
        }
        // A cable appears when either end's level is questioned
        // (nested-tracks.md §19): the edge's gain is part of the answer
        // neither track file shows in full.
        for (const cable of e.levels.cables) {
          process.stdout.write(`cable: ${formatCable(cable, e.levels.track)}\n`);
        }
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
    for (const p of result.pinned) {
      process.stdout.write(
        `pinned ${p.plugin} → ${p.format} ${p.identifier} ${p.version} (${p.file})\n`,
      );
    }
    for (const d of result.diagnostics) {
      process.stdout.write(`${formatDiagnostic(d)}\n`);
    }
    for (const f of result.unformatted) {
      process.stdout.write(`${f}: not canonically formatted (run field fmt)\n`);
    }
    if (result.ok) process.stdout.write('ok\n');
    process.exit(result.ok ? 0 : 1);
  });

const plugins = program.command('plugins').description('hosted plugin inventory');
plugins
  .command('scan')
  .description('scan installed AU/VST3 plugins into .field/plugins.json')
  .action(async () => {
    const { scanCommand } = await import('./commands/plugins.js');
    try {
      scanCommand(requireRoot());
    } catch (err) {
      fail(err);
    }
  });
plugins
  .command('list')
  .description('print the scanned plugin inventory')
  .action(async () => {
    const { listCommand } = await import('./commands/plugins.js');
    listCommand(requireRoot());
  });
plugins
  .command('pin')
  .description('write plugin identities, versions and latency back into track files')
  .option('--au', 'prefer the AU when a name matches both formats')
  .option('--vst3', 'prefer the VST3 when a name matches both formats')
  .option('--update', 'accept installed versions over drifted pins (a deliberate re-render)')
  .action(async (options: { au?: boolean; vst3?: boolean; update?: boolean }) => {
    const { pinCommand } = await import('./commands/plugins.js');
    const prefer = options.au === true ? 'au' : options.vst3 === true ? 'vst3' : undefined;
    const ok = pinCommand(requireRoot(), {
      ...(prefer !== undefined ? { prefer } : {}),
      ...(options.update !== undefined ? { update: options.update } : {}),
    });
    if (!ok) process.exit(1);
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
  .command('arrangement <song>')
  .description("the song's structure, derived from its output track's placements")
  .action(async (songName: string) => {
    try {
      const { arrangement } = await import('./commands/arrangement.js');
      process.stdout.write(`${arrangement(requireRoot(), songName)}\n`);
    } catch (err) {
      fail(err);
    }
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
      const inputs = song.tracks.reduce((n, t) => n + t.data.inputs.length, 0);
      process.stdout.write(`  ${song.name}: ${song.tracks.length} tracks, ${inputs} inputs\n`);
    }
    const problems = diagnosticErrors(project.diagnostics).length;
    const warned = project.diagnostics.length - problems;
    if (problems > 0) process.stdout.write(`${problems} problems (run field check)\n`);
    if (warned > 0) process.stdout.write(`${warned} warnings (run field check)\n`);
  });

// Positional: `argv[2]` is the only place this flag means the whole
// program. `includes()` matched it anywhere, so `field build --version`
// printed a version report and silently never built — a parser would have
// rejected an unknown option on `build`, where this substituted a
// different command (#70 review). Every other shape goes to commander,
// which already knows how to complain about it.
if (wantsVersion(process.argv)) {
  await printVersion().catch(fail);
} else {
  await program.parseAsync();
}
