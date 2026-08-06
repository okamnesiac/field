import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { AcedClient } from '../aced/client.js';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { barTicks, TempoMap } from '../time/tempo.js';

const execFileAsync = promisify(execFile);

// bloom ace (ace-generation.md §3): generation lives OUTSIDE the build
// graph — outputs are committed, not cached. `generate` runs the model
// through bloom-aced and lands variants plus a provenance recipe under
// songs/<song>/generation/; choosing and promoting a variant to an asset
// is chunk 2.

export interface AceGenerateOptions {
  song: string;
  prompt: string;
  seed: number;
  bars?: number | undefined;
  durationSeconds?: number | undefined;
  variants: number;
  lyrics?: string | undefined;
  bpm?: number | undefined;
  onProgress?: ((stage: string) => void) | undefined;
}

export interface AceGenerateResult {
  recipePath: string; // project-relative
  files: string[]; // project-relative variant WAVs, seed order
  seeds: number[];
  model: string;
  durationSeconds: number;
  bpm: number | undefined;
}

interface SongTime {
  tempoMap: TempoMap;
  initialBpm: number;
  ticksPerBar: number;
}

function songTime(project: LoadedProject, songName: string): SongTime {
  const song = project.songs.find((s) => s.name === songName);
  if (!song) throw new Error(`no such song "${songName}"`);
  if (!song.tempo) throw new Error(`song "${songName}" has no tempo.yaml`);
  const rate = project.manifest?.data.sample_rate ?? DEFAULT_SAMPLE_RATE;
  return {
    tempoMap: new TempoMap(song.tempo.data.tempo, rate),
    initialBpm: song.tempo.data.tempo[0]!.bpm,
    ticksPerBar: barTicks(song.tempo.data.meter[0]!),
  };
}

export async function aceGenerate(
  root: string,
  name: string,
  options: AceGenerateOptions,
): Promise<AceGenerateResult> {
  if (!isSlug(name)) throw new Error(`generation name "${name}" must be a lowercase-slug`);
  if ((options.bars === undefined) === (options.durationSeconds === undefined)) {
    throw new Error('give exactly one of --bars or --duration');
  }

  const project = loadProject(root);
  const time = songTime(project, options.song);
  // Musical time projects CLI-side; the worker never learns what a bar is.
  const durationSeconds =
    options.durationSeconds ??
    time.tempoMap.ticksToSeconds(options.bars! * time.ticksPerBar);
  // The model wants a whole-number hint; ramped songs get their opening tempo.
  const bpm = options.bpm ?? Math.round(time.initialBpm);

  const generationDir = join(root, 'songs', options.song, 'generation');
  const outputDir = join(generationDir, name);
  const recipeAbsolute = join(generationDir, `${name}.yaml`);
  if (existsSync(recipeAbsolute)) {
    throw new Error(`generation "${name}" already exists in ${options.song} (pick a new name)`);
  }
  mkdirSync(outputDir, { recursive: true });

  const client = await AcedClient.connect(root);
  try {
    client.on('event', (e: { event: string; stage?: string }) => {
      if (e.event === 'progress' && e.stage) options.onProgress?.(e.stage);
    });
    const response = await client.generate({
      prompt: options.prompt,
      duration_seconds: durationSeconds,
      seed: options.seed,
      variants: options.variants,
      output_dir: outputDir,
      lyrics: options.lyrics,
      bpm,
    });

    // The worker writes uuid names; variants get deterministic, seed-order
    // names the recipe can reference readably.
    const files: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < response.paths.length; i++) {
      const target = join(outputDir, `${name}-${i + 1}.wav`);
      renameSync(response.paths[i]!, target);
      files.push(join('songs', options.song, 'generation', name, `${name}-${i + 1}.wav`));
      hashes.push(await sha256File(target));
    }

    // Provenance (§1 of the plan): everything needed to audit or
    // deliberately regenerate. Formal schema + choose/promote is chunk 2.
    const recipe = {
      name,
      model: response.model,
      prompt: options.prompt,
      ...(options.lyrics !== undefined ? { lyrics: options.lyrics } : {}),
      bpm,
      duration_seconds: Number(durationSeconds.toFixed(3)),
      ...(options.bars !== undefined ? { bars: options.bars } : {}),
      seed: options.seed,
      variants: files.map((file, i) => ({
        file: `${name}/${name}-${i + 1}.wav`,
        seed: response.seeds[i] ?? options.seed + i,
        sha256: hashes[i]!,
      })),
      generated_at: new Date().toISOString(),
    };
    writeFileSync(recipeAbsolute, stringify(recipe));

    return {
      recipePath: join('songs', options.song, 'generation', `${name}.yaml`),
      files,
      seeds: response.seeds,
      model: response.model,
      durationSeconds,
      bpm,
    };
  } finally {
    client.close();
  }
}

// Explicit, loud environment setup (ace-generation.md §3.4): uv sync for
// the worker env. The multi-GB weights download happens on the first
// generate, announced by its progress events.
export async function aceSetup(onLine: (line: string) => void): Promise<void> {
  const { acedAvailable } = await import('../aced/client.js');
  const available = acedAvailable();
  if (!available.ok) throw new Error(available.reason ?? 'bloom-aced unavailable');
  const project = join(
    new URL('../../python/aced', import.meta.url).pathname,
  );
  onLine('syncing the bloom-aced environment (uv)…');
  const { stderr } = await execFileAsync('uv', ['sync', '--project', project], {
    maxBuffer: 10 * 1024 * 1024,
  });
  for (const line of stderr.split('\n').slice(-5)) if (line.trim()) onLine(line);
  onLine('environment ready — the first `bloom ace generate` downloads ~10 GB of model weights');
}
