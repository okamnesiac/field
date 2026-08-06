import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Document, parseDocument } from 'yaml';
import { AcedClient } from '../aced/client.js';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { RESERVED_TARGET_NAME } from '../labels.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { generateSoundSchema, soundOrder, soundSchema } from '../schema/index.js';
import { barTicks, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

const execFileAsync = promisify(execFile);

// bloom generate / bloom choose (project-layout.md §1.4, §1.7, §4): the
// deliberate-trigger verbs over the generator category. Generation lives
// OUTSIDE the build graph — outputs are committed, not cached. `generate`
// runs the model (the recipe's `model:` field says which generator) and
// lands variants in songs/<song>/audio/<name>/ with the recipe as a
// deliberate sound in sounds/<name>.yaml; `choose` repoints which
// variant the sound's own label resolves to — clips reference the sound
// by name, so choosing again moves what they play, and nothing is ever
// copied into a ledger.

export interface GenerateOptions {
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

export interface GenerateResult {
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

export async function generateVariants(
  root: string,
  name: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  if (!isSlug(name)) throw new Error(`sound name "${name}" must be a lowercase-slug`);
  if (name === RESERVED_TARGET_NAME) {
    throw new Error(`"${RESERVED_TARGET_NAME}" is reserved by the label grammar`);
  }
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

  const songDir = join(root, 'songs', options.song);
  const outputDir = join(songDir, 'audio', name);
  const recipeAbsolute = join(songDir, 'sounds', `${name}.yaml`);
  if (existsSync(recipeAbsolute)) {
    throw new Error(`sound "${name}" already exists in ${options.song} (pick a new name)`);
  }
  // One namespace per song (§4.3): the sound's name must not shadow an
  // asset, or `source: <name>` stops meaning one thing.
  const song = project.songs.find((s) => s.name === options.song);
  if (song?.assets?.data.assets.some((a) => a.name === name)) {
    throw new Error(
      `"${name}" is already an asset in ${options.song} — a song's names are one namespace (pick a new name)`,
    );
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
    // names. The directory carries the identity, so the filename is just
    // the number (project-layout.md §3, decided at migration).
    const files: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < response.paths.length; i++) {
      const target = join(outputDir, `${i + 1}.wav`);
      renameSync(response.paths[i]!, target);
      files.push(join('songs', options.song, 'audio', name, `${i + 1}.wav`));
      hashes.push(await sha256File(target));
    }

    // Provenance: everything needed to audit or deliberately regenerate.
    // Parsed through the schema before writing — this command must never
    // emit a target `bloom check` would reject — and canonicalized so
    // `bloom fmt` is a no-op on fresh recipes.
    const recipe = generateSoundSchema.parse({
      name,
      type: 'generate',
      model: response.model,
      prompt: options.prompt,
      ...(options.lyrics !== undefined ? { lyrics: options.lyrics } : {}),
      bpm,
      duration_seconds: Number(durationSeconds.toFixed(3)),
      ...(options.bars !== undefined ? { bars: options.bars } : {}),
      seed: options.seed,
      variants: files.map((_, i) => ({
        file: `audio/${name}/${i + 1}.wav`,
        seed: response.seeds[i]!, // schema guarantees paths/seeds align
        sha256: hashes[i]!,
      })),
      generated_at: new Date().toISOString(),
    });
    mkdirSync(join(songDir, 'sounds'), { recursive: true });
    const doc = new Document(recipe);
    canonicalizeDocument(doc, soundOrder);
    writeFileSync(recipeAbsolute, stringifyDocument(doc));

    return {
      recipePath: join('songs', options.song, 'sounds', `${name}.yaml`),
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

export interface ChooseOptions {
  song: string;
  variant: number; // 1-based, matching the file names and recipe order
}

export interface ChooseResult {
  file: string; // song-relative, what the sound's label now resolves to
  sha256: string;
  bytes: number;
  previous?: number | undefined; // the previously chosen variant, if any
}

// Choosing repoints what the sound *means* (project-layout.md §1.4, §4):
// the sound's own label resolves to its chosen variant, clips reference
// the sound by name, and the bytes never move — so choosing again is a
// one-line diff and every reference follows. There is no ledger step:
// the sound file itself pins its variants (sha256 per variant, verified
// by check), and a same-name asset would violate the song's one
// namespace anyway.
export async function chooseVariant(
  root: string,
  name: string,
  options: ChooseOptions,
): Promise<ChooseResult> {
  // Both names build paths; both must be slugs before any join.
  if (!isSlug(name)) throw new Error(`sound name "${name}" must be a lowercase-slug`);
  if (!isSlug(options.song)) throw new Error(`song "${options.song}" must be a lowercase-slug`);
  const songDir = join(root, 'songs', options.song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${options.song}" does not exist`);
  }
  const recipePath = join(songDir, 'sounds', `${name}.yaml`);
  if (!existsSync(recipePath)) {
    throw new Error(`no sound "${name}" in ${options.song}`);
  }
  const recipeDoc = parseDocument(readFileSync(recipePath, 'utf8'));
  if (recipeDoc.errors.length > 0) {
    throw new Error(`invalid YAML in ${name}.yaml: ${recipeDoc.errors[0]!.message}`);
  }
  const recipe = soundSchema.safeParse(recipeDoc.toJS());
  if (!recipe.success) {
    throw new Error(`sound ${name}.yaml is invalid; fix it before choosing (bloom check)`);
  }
  if (recipe.data.type !== 'generate') {
    throw new Error(
      `"${name}" is a ${recipe.data.type} sound — only deliberate generate sounds have variants to choose`,
    );
  }

  const variant = recipe.data.variants[options.variant - 1];
  if (!variant) {
    throw new Error(
      `variant ${options.variant} does not exist (${recipe.data.variants.length} variants)`,
    );
  }
  const absolute = join(songDir, variant.file);
  if (!existsSync(absolute)) throw new Error(`variant file not found: ${variant.file}`);
  // Choosing asserts provenance, so the bytes must still be the bytes the
  // recipe recorded — drifted output gets diagnosed, never chosen.
  const sha256 = await sha256File(absolute);
  if (sha256 !== variant.sha256) {
    throw new Error(
      `variant ${options.variant} does not match its recorded sha256 — refusing to choose (bloom check)`,
    );
  }
  const bytes = statSync(absolute).size;

  const previous = recipe.data.chosen;
  recipeDoc.setIn(['chosen'], options.variant);
  canonicalizeDocument(recipeDoc, soundOrder);
  writeFileSync(recipePath, stringifyDocument(recipeDoc));

  return { file: variant.file, sha256, bytes, previous };
}

// Explicit, loud environment setup (ace-generation.md §3.4): uv sync for
// the worker env. The multi-GB weights download happens on the first
// generate, announced by its progress events.
export async function setupWorker(onLine: (line: string) => void): Promise<void> {
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
  onLine('environment ready — the first `bloom generate` downloads ~10 GB of model weights');
}
