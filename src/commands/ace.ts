import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Document, isSeq, parseDocument } from 'yaml';
import { AcedClient } from '../aced/client.js';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { RESERVED_TARGET_NAME } from '../labels.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import {
  assetsFileOrder,
  assetsFileSchema,
  generationRecipeOrder,
  generationRecipeSchema,
} from '../schema/index.js';
import { barTicks, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

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
    // deliberately regenerate. Parsed through the schema before writing —
    // this command must never emit a recipe `bloom check` would reject —
    // and canonicalized so `bloom fmt` is a no-op on fresh recipes.
    const recipe = generationRecipeSchema.parse({
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
        seed: response.seeds[i]!, // schema guarantees paths/seeds align
        sha256: hashes[i]!,
      })),
      generated_at: new Date().toISOString(),
    });
    const doc = new Document(recipe);
    canonicalizeDocument(doc, generationRecipeOrder);
    writeFileSync(recipeAbsolute, stringifyDocument(doc));

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

export interface AceChooseOptions {
  song: string;
  variant: number; // 1-based, matching the file names and recipe order
  as?: string | undefined;
}

export interface AceChooseResult {
  assetName: string;
  file: string; // song-relative
  sha256: string;
  bytes: number;
  replaced: boolean; // a previous choose for this generation was updated
}

// Promotion (ace-generation.md §4.2, build-graph.md): a reference to a
// content-addressed artifact — cheap, and reversible. The variant's bytes
// stay where they are under generation/; choosing declares them in
// assets.yaml so clips can reference the name. Choosing again moves the
// reference — it only ever replaces an entry a previous choose created.
export async function aceChoose(
  root: string,
  name: string,
  options: AceChooseOptions,
): Promise<AceChooseResult> {
  // Both names build paths; both must be slugs before any join.
  if (!isSlug(name)) throw new Error(`generation name "${name}" must be a lowercase-slug`);
  if (!isSlug(options.song)) throw new Error(`song "${options.song}" must be a lowercase-slug`);
  const songDir = join(root, 'songs', options.song);
  if (!existsSync(join(songDir, 'song.yaml'))) {
    throw new Error(`song "${options.song}" does not exist`);
  }
  const recipePath = join(songDir, 'generation', `${name}.yaml`);
  if (!existsSync(recipePath)) {
    throw new Error(`no generation "${name}" in ${options.song}`);
  }
  const recipeDoc = parseDocument(readFileSync(recipePath, 'utf8'));
  if (recipeDoc.errors.length > 0) {
    throw new Error(`invalid YAML in ${name}.yaml: ${recipeDoc.errors[0]!.message}`);
  }
  const recipe = generationRecipeSchema.safeParse(recipeDoc.toJS());
  if (!recipe.success) {
    throw new Error(`recipe ${name}.yaml is invalid; fix it before choosing (bloom check)`);
  }

  const variant = recipe.data.variants[options.variant - 1];
  if (!variant) {
    throw new Error(
      `variant ${options.variant} does not exist (${recipe.data.variants.length} variants)`,
    );
  }
  const file = posix.join('generation', variant.file);
  const absolute = join(songDir, 'generation', variant.file);
  if (!existsSync(absolute)) throw new Error(`variant file not found: ${file}`);
  // Promotion asserts provenance, so the bytes must still be the bytes the
  // recipe recorded — drifted output gets diagnosed, never promoted.
  const sha256 = await sha256File(absolute);
  if (sha256 !== variant.sha256) {
    throw new Error(
      `variant ${options.variant} does not match its recorded sha256 — refusing to promote (bloom check)`,
    );
  }
  const bytes = statSync(absolute).size;

  const assetName = options.as ?? name;
  if (!isSlug(assetName)) {
    throw new Error(`asset name "${assetName}" must be a lowercase-slug (use --as)`);
  }
  if (assetName === RESERVED_TARGET_NAME) {
    throw new Error(`"${RESERVED_TARGET_NAME}" is reserved by the label grammar (use --as)`);
  }

  const assetsPath = join(songDir, 'assets.yaml');
  let doc: Document;
  if (existsSync(assetsPath)) {
    const parsed = parseDocument(readFileSync(assetsPath, 'utf8'));
    if (parsed.errors.length > 0) {
      throw new Error(`invalid YAML in assets.yaml: ${parsed.errors[0]!.message}`);
    }
    doc = parsed;
  } else {
    doc = new Document({ assets: [] });
  }
  const existing = assetsFileSchema.safeParse(doc.toJS());
  if (!existing.success) {
    throw new Error(`assets.yaml is invalid; fix it before choosing (bloom check)`);
  }

  // Same file under a different name is a promotion that already happened.
  const other = existing.data.assets.find(
    (a) => a.name !== assetName && resolve(songDir, a.file) === resolve(songDir, file),
  );
  if (other) {
    throw new Error(`variant ${options.variant} is already promoted as asset "${other.name}"`);
  }
  // A same-name entry may only be replaced if a previous choose for this
  // generation created it — never an unrelated asset the name collides with.
  const generationPrefix = resolve(songDir, 'generation', name) + sep;
  const index = existing.data.assets.findIndex((a) => a.name === assetName);
  const prior = index >= 0 ? existing.data.assets[index]! : undefined;
  if (prior && !resolve(songDir, prior.file).startsWith(generationPrefix)) {
    throw new Error(
      `asset "${assetName}" already declared in "${options.song}" and is not a ` +
        `promotion of this generation (use --as)`,
    );
  }

  const entry = { name: assetName, file, sha256, bytes };
  if (index >= 0) {
    doc.setIn(['assets', index], doc.createNode(entry));
  } else {
    if (!isSeq(doc.getIn(['assets']))) {
      // `{}` or `assets:` (null) parse fine but have no sequence for addIn
      // to extend; without this it would set a bare map and corrupt the file.
      doc.setIn(['assets'], doc.createNode([]));
    }
    doc.addIn(['assets'], doc.createNode(entry));
  }
  canonicalizeDocument(doc, assetsFileOrder);
  writeFileSync(assetsPath, stringifyDocument(doc));

  // The annotation comes second: a crash between the writes leaves a
  // working promotion whose recipe understates it — re-running choose
  // repairs that. The reverse order could leave `chosen` pointing at a
  // promotion that never landed.
  recipeDoc.setIn(['chosen'], options.variant);
  canonicalizeDocument(recipeDoc, generationRecipeOrder);
  writeFileSync(recipePath, stringifyDocument(recipeDoc));

  return { assetName, file, sha256, bytes, replaced: prior !== undefined };
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
