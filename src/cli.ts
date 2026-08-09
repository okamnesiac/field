#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  parseBars,
  parseBpm,
  parseChannels,
  parseConviction,
  parseDurationSeconds,
  parseExaggeration,
  parseSeed,
  parseVariantNumber,
  parseVariants,
  wantsVersion,
} from './cliParsers.js';
import { buildLabels, explainLabel, projectRelative, queryDeps } from './commands/build.js';
import { formatReach, rootNote } from './model/levels.js';
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
import { findProjectRoot, loadProject } from './model/project.js';

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
  .description('render an SC program directly (uncached, for iteration; commit it as a sound for builds)')
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
  .command('generate <name>')
  .description('run a deliberate generator: fills a generative entry (by its gen node name) or a sound; variants land in songs/<song>/audio/<name>/')
  .requiredOption('--song <name>', 'song the sound belongs to (its tempo map projects --bars)')
  .option('--prompt <text>', 'what to generate — music, through field-aced')
  .option('--text <line>', 'the line to speak or sing — voice, through field-voiced')
  .requiredOption('--seed <n>', 'base seed; variant i uses seed+i', parseSeed)
  .option('--bars <n>', 'music: length in bars at the song tempo (or use --duration)', parseBars)
  .option('--duration <seconds>', 'music: length in seconds (or use --bars)', parseDurationSeconds)
  .option('--variants <n>', 'how many variants (1-8)', parseVariants, 2)
  .option('--lyrics <text>', 'music: lyrics (omit for instrumental)')
  .option('--bpm <n>', 'music: override the tempo-map bpm hint', parseBpm)
  .option('--voice-ref <asset>', "voice: the committed recording that defines the voice (omit for the model's own)")
  .option('--exaggeration <n>', 'voice: expressive intensity, 0.25-2 (lower is calmer and slower)', parseExaggeration)
  .option('--conviction <n>', 'voice: how hard it commits to the on-text reading, 0.1-1 (lower lingers)', parseConviction)
  .action(async (name: string, opts: {
    song: string; prompt?: string; text?: string; seed: number; bars?: number; duration?: number;
    variants: number; lyrics?: string; bpm?: number; voiceRef?: string;
    exaggeration?: number; conviction?: number;
  }) => {
    try {
      const { generateVariants } = await import('./commands/generate.js');
      const result = await generateVariants(requireRoot(), name, {
        song: opts.song,
        prompt: opts.prompt,
        text: opts.text,
        seed: opts.seed,
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
        `generated ${result.files.length} variants (${detail}${result.model})\n`,
      );
      for (const file of result.files) process.stdout.write(`  ${file}\n`);
      process.stdout.write(`recipe: ${result.recipePath}\n`);
      process.stdout.write(
        `audition: field play ${opts.song}/${result.pkg}:${name}-1\n` +
          `choose:   field choose ${name} --song ${opts.song} --variant <n>\n`,
      );
    } catch (err) {
      fail(err);
    }
  });
program
  .command('choose <name>')
  .description("repoint which committed variant a gen node's (or generate sound's) label resolves to")
  .requiredOption('--song <name>', 'song the sound belongs to')
  .requiredOption('--variant <n>', 'variant number (1-based, as played/numbered)', parseVariantNumber)
  .action(async (name: string, opts: { song: string; variant: number }) => {
    try {
      const { chooseVariant } = await import('./commands/generate.js');
      const result = await chooseVariant(requireRoot(), name, {
        song: opts.song,
        variant: opts.variant,
      });
      const moved = result.previous !== undefined && result.previous !== opts.variant;
      process.stdout.write(
        `${moved ? 'moved' : 'chose'} ${name} → variant ${opts.variant} (${result.file})\n` +
          (result.pkg === 'gen'
            ? `//songs/${opts.song}/gen:${name} now plays it; every placement follows\n`
            : `//songs/${opts.song}/sound:${name} now plays it; entries reference it as sound: ${name}\n`),
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
  .description('build labels (creek/sound:pad-96k, creek/..., or a bare song for its output track)')
  .option('--watch', 'rebuild on project changes until ctrl-c, reporting outputs that audibly moved')
  .action(async (patterns: string[], opts: { watch?: boolean }) => {
    try {
      const root = requireRoot();
      if (opts.watch !== true) {
        const outcomes = await buildLabels(root, patterns);
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
  .action(async (patterns: string[], opts: { to?: string }) => {
    try {
      const { exportLabels, homeRelative } = await import('./commands/export.js');
      const results = await exportLabels(requireRoot(), patterns, { to: opts.to });
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
  .option('--device <name>', 'output device (field devices lists them)')
  .option('--loop', 'replay the queue until ctrl-c')
  .option('--click', 'overlay a metronome (rendered CLI-side; loops with the file)')
  .option('--watch', 'rebuild on project changes, swap the loop at the wrap (needs --loop, one label)')
  .action(async (patterns: string[], opts: { from?: string; device?: string; loop?: boolean; click?: boolean; watch?: boolean }) => {
    try {
      const root = requireRoot();
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
      if (opts.watch === true && (opts.loop !== true || items.length !== 1)) {
        // A multi-item --loop queue is requeue-path playback with no wrap
        // to swap at (watch.md §1.4); build --watch is the multi-label form.
        throw new Error(
          `--watch needs --loop and exactly one label (got ${items.length}) — watch.md §1.4`,
        );
      }
      if (opts.watch === true && opts.click === true) {
        // The click bakes into a CLI-side temp file, which a swap would
        // silently drop — refuse rather than un-click the loop mid-listen.
        throw new Error('--watch does not compose with --click yet');
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

      const project = loadProject(root);
      if (opts.click === true) {
        const { applyClick } = await import('./commands/click.js');
        items = applyClick(root, project, items);
      }
      const tty = process.stdout.isTTY === true;
      let onPositionLine = false;
      // On a tty, a watch session renders the live two-line block (header
      // + position, loop-ui.ts) with the queued takeover on the position
      // line; everywhere else — non-tty, or plain play — plain lines.
      const loopUi = tty && opts.watch === true ? await import('./commands/loop-ui.js') : undefined;
      const display = loopUi
        ? new loopUi.LoopDisplay((chunk) => process.stdout.write(chunk), {
            // --from takes the requeue path: passes come from onItem,
            // not from position regression.
            requeue: opts.from !== undefined,
            columns: () => process.stdout.columns ?? 120,
          })
        : undefined;
      const say = (line: string): void => {
        if (display) {
          display.say(line);
          return;
        }
        if (onPositionLine) process.stdout.write('\n');
        onPositionLine = false;
        process.stdout.write(`${line}\n`);
      };

      // --watch (watch.md §1.4): watch-build the same pattern alongside
      // the blocking play; when the played label's output hash moves, the
      // native loop queues a daemon reload (takeover at the wrap), and a
      // --from region loop just repoints what the next pass loads.
      let watchDone = Promise.resolve();
      let fresh: string | undefined;
      let started = false; // first onItem opens the display block; later ones are passes
      // A takeover reported before that first load, held until there is
      // something to take over from.
      let heldForStart: BuildOutcome | undefined;
      let takeover: (moved: BuildOutcome) => void = () => {};
      if (opts.watch === true) {
        const item = items[0]!;
        const native = opts.from === undefined;
        const reloadClient = native ? await AudiodClient.connect(root) : undefined;
        if (reloadClient) {
          const [major = 0, minor = 0] = reloadClient.daemonVersion.split('.').map(Number);
          if (major === 0 && minor < 4) {
            reloadClient.close();
            throw new Error(
              `field-audiod ${reloadClient.daemonVersion} predates --watch — ` +
                'field transport quit, then play again (it respawns on the new build)',
            );
          }
        }
        // A rebuilt artifact takes over: the native loop asks the daemon to
        // swap at the wrap, a --from region loop repoints what the next
        // pass loads.
        takeover = (moved: BuildOutcome): void => {
          const path = moved.outputPath!;
          if (reloadClient) {
            void reloadClient.reload(path).then(
              () =>
                display
                  ? display.queue(moved.sha256, path)
                  : say(`↻ ${moved.label} ${moved.sha256.slice(0, 12)} at the next wrap`),
              // A ctrl-c racing an in-flight reload closes the socket
              // under it; that is the session ending, not a failure.
              (err: Error) => {
                display?.dequeue();
                if (!watchAbort.signal.aborted) say(`reload failed: ${err.message}`);
              },
            );
          } else {
            fresh = path;
            if (display) display.queue(moved.sha256, path);
            else say(`↻ ${moved.label} ${moved.sha256.slice(0, 12)} next pass`);
          }
        };
        const { watchBuild } = await import('./commands/watch.js');
        watchDone = watchBuild(
          root,
          patterns,
          // The baseline is what the daemon starts looping: an edit that
          // lands between the play's own build and the watcher's first
          // pass is reported and swapped, not silently absorbed.
          { signal: watchAbort.signal, baseline: new Map([[item.label, item.sha256]]) },
          {
            onDiagnostics: (lines) => {
              for (const line of lines) say(`check: ${line}`);
            },
            onError: (err, phase) => say(`${phase} failed: ${err.message}`),
            onOutcomes: (_outcomes, changed) => {
              const moved = changed.find((o) => o.label === item.label);
              if (!moved?.outputPath) return;
              // The seeded baseline can report drift before the play's own
              // load has happened — a reload then has nothing to take over
              // from and errors. Hold it for the first load, which the
              // block opens on; the wrap's `reloaded` corrects the header
              // if those bytes were already the new ones (#35 review).
              if (!started) {
                heldForStart = moved;
                return;
              }
              takeover(moved);
            },
          },
        ).finally(() => reloadClient?.close());
      }

      try {
        await playThroughDaemon(
          root,
          project,
          items,
          { ...opts, currentPath: opts.watch === true ? () => fresh : undefined },
          {
            onItem: (label, note, path) => {
              const first = !started;
              started = true;
              // The first pass opens the block; later ones (the requeue
              // path reloads every pass) are pass boundaries — the pass
              // that loads what the watch queued opens the successor's
              // block, with the hash correlated by path, never the
              // snapshot from before the session (#37 review P2).
              if (!display) say(`playing ${label}${note}`);
              else if (first) {
                // What opened may already be the held rebuild's bytes —
                // correlated by path, never assumed from the snapshot.
                display.start(
                  label,
                  loopUi!.openingHash(path, items[0]!.sha256, heldForStart),
                  note,
                );
              } else display.pass(path);
              // Now there is something to take over from: release the
              // rebuild that beat the first load, if one did.
              if (first && heldForStart !== undefined) {
                const held = heldForStart;
                heldForStart = undefined;
                takeover(held);
              }
            },
            onPosition: (line, at) => {
              if (display) {
                display.position(line, at);
              } else if (tty) {
                process.stdout.write(`\r  ${line}   `);
                onPositionLine = true;
              }
            },
            onDevice: (name) =>
              display ? display.deviceMoved(name) : say(`→ output moved to ${name}`),
            onReloaded: (path) =>
              display ? display.swapped(path) : say('↻ swapped at the wrap'),
            interrupted: () => interrupted,
          },
        );
      } finally {
        watchAbort.abort();
        await watchDone;
      }
      display?.end();
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
  .description("query the graph: a pattern, or deps(creek/sound:pad-96k)")
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
      process.stdout.write(`${f}: not canonically formatted (run field fmt)\n`);
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
      process.stdout.write(
        `  ${song.name}: ${song.tracks.length} tracks, ${inputs} inputs, ${song.takes.length} takes\n`,
      );
    }
    if (project.diagnostics.length > 0) {
      process.stdout.write(`${project.diagnostics.length} problems (run field check)\n`);
    }
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
