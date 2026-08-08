import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Document, parseDocument } from 'yaml';
import { AcedClient, ACED_SPEC } from '../aced/client.js';
import { VoicedClient, VOICED_SPEC } from '../voiced/client.js';
import { workerPackagePresent } from '../workers/client.js';
import type { WorkerSpec } from '../workers/protocol.js';
import { sha256File } from '../hash.js';
import { isSlug } from '../ids.js';
import { DEFAULT_SAMPLE_RATE } from '../constants.js';
import { RESERVED_LABEL_NAME } from '../labels.js';
import { loadProject, lookupAsset, type LoadedProject } from '../model/project.js';
import { takenSongNames } from '../model/namespace.js';
import { generativeSoundSchema, soundOrder, soundSchema } from '../schema/index.js';
import { barTicks, TempoMap } from '../time/tempo.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

const execFileAsync = promisify(execFile);

// field generate / field choose (project-layout.md §1.4, §1.7, §4): the
// deliberate-trigger verbs over the generator category. Generation lives
// OUTSIDE the build graph — outputs are committed, not cached. `generate`
// runs the model (the recipe's `model:` field says which generator) and
// lands variants in songs/<song>/audio/<name>/ with the recipe as a
// deliberate sound in sounds/<name>.yaml; `choose` repoints which
// variant the sound's own label resolves to — clips reference the sound
// by name, so choosing again moves what they play, and nothing is ever
// copied into a ledger.
//
// One verb, two generators (voice-generation.md §4, answered by
// project-layout.md §1.7): `--prompt` routes to field-aced, `--text` to
// field-voiced, and the recipe's `model:` records which one ran. The
// recipe schema discriminates the same way, on which of prompt/text is
// present rather than a second `type:` (§1.6), so the CLI is stating the
// schema's kind split in flag vocabulary rather than inventing a rule.

export interface GenerateOptions {
  song: string;
  seed: number;
  variants: number;
  // Music, through field-aced: a prompt and a length.
  prompt?: string | undefined;
  bars?: number | undefined;
  durationSeconds?: number | undefined;
  lyrics?: string | undefined;
  bpm?: number | undefined;
  // Voice, through field-voiced: the line, and optionally the committed
  // recording that defines the voice — an asset *name*, resolved to a
  // path here so the worker never learns what an asset is. Omitted means
  // the model's own voice, a first-class case (§6).
  text?: string | undefined;
  voiceRef?: string | undefined;
  // How the line is delivered. `conviction` is Chatterbox's `cfg_weight`
  // under a name that says what it does (voice-generation.md §8); the
  // worker's adapter translates. Absent means the model's own default,
  // and the recipe records the absence rather than inventing a number.
  exaggeration?: number | undefined;
  conviction?: number | undefined;
  onProgress?: ((stage: string) => void) | undefined;
}

export interface GenerateResult {
  recipePath: string; // project-relative
  files: string[]; // project-relative variant WAVs, seed order
  seeds: number[];
  model: string;
  // Music only. A voice line has no requested length — its length
  // follows from the text, and the committed WAV is its own record.
  durationSeconds?: number | undefined;
  bpm?: number | undefined;
  voiceRef?: string | undefined; // as written into the recipe
}

// The flags that belong to exactly one kind, and what to call them when
// one shows up on the other. Checked before anything is spawned: the
// schema would reject the same recipe on the way to disk, but by then
// the model minutes are spent — the same reasoning as the namespace
// pre-flight below.
const MUSIC_ONLY: [keyof GenerateOptions, string][] = [
  ['bars', '--bars'],
  ['durationSeconds', '--duration'],
  ['lyrics', '--lyrics'],
  ['bpm', '--bpm'],
];
const VOICE_ONLY: [keyof GenerateOptions, string][] = [
  ['voiceRef', '--voice-ref'],
  ['exaggeration', '--exaggeration'],
  ['conviction', '--conviction'],
];

export type GenerationKind = 'music' | 'voice';

function generationKind(options: GenerateOptions): GenerationKind {
  const isMusic = options.prompt !== undefined;
  const isVoice = options.text !== undefined;
  if (isMusic === isVoice) {
    throw new Error(
      isMusic
        ? 'give either --prompt (music) or --text (voice), not both'
        : 'give --prompt to generate music, or --text to generate a voice line',
    );
  }
  for (const [key, flag] of isVoice ? MUSIC_ONLY : VOICE_ONLY) {
    if (options[key] !== undefined) {
      throw new Error(
        isVoice
          ? `${flag} is a music option — a voice recipe carries --text and optionally ` +
            `--voice-ref (voice-generation.md §1.6)`
          : `${flag} is a voice option — a music recipe carries --prompt`,
      );
    }
  }
  if (isMusic && (options.bars === undefined) === (options.durationSeconds === undefined)) {
    throw new Error('give exactly one of --bars or --duration');
  }
  return isVoice ? 'voice' : 'music';
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

// A `voice_ref` is a name in the song's namespace; the worker needs a
// path and the recipe needs a hash. Turning one into the other is the
// first place field *writes* a content hash into a committed file rather
// than checking one somebody else wrote, so it is written to be a pin
// from the start (voice-generation.md §1.3, §6):
//
//   - the name resolves through the same lookupAsset the project model
//     validates with, so "which asset is this" has one answer;
//   - it must be a committed *asset*, not any visible name — a generated
//     sound cannot carry the provenance the reference exists to give;
//   - the hash written is the hash of the bytes actually read, and a
//     recording that has drifted from its ledger entry is refused rather
//     than generated from. Recording the ledger's value instead would
//     leave the recipe check-green while describing bytes the model
//     never heard, which is the one thing a recipe must never do —
//     the refusal `field choose` already makes about a drifted variant.
//
// The last of those needs the *bytes*, not the file, or it is a promise
// about one instant: hashing the recording and then handing the worker
// its path leaves minutes of model load between the two, and a recording
// edited in that window is generated from while the recipe pins what it
// used to be. Re-hashing afterwards does not close it — an edit that is
// undone before the run ends compares equal at both ends and passes.
// So the window is removed rather than checked: the reference is copied
// first, and the copy is what gets hashed and what the worker reads.
// Hashed and heard are then the same bytes by construction.
async function snapshotVoiceRef(
  project: LoadedProject,
  song: string,
  ref: string,
  into: string,
): Promise<{ path: string; sha256: string }> {
  const found = lookupAsset(project, song, ref);
  if (!found) {
    throw new Error(
      `voice_ref "${ref}" is not a committed asset in ${song} — a reference recording is ` +
        `an asset (field import), not a sound (voice-generation.md §1.3)`,
    );
  }
  // An ambiguous name is not a name. Two ledger rows called `ref-voice`
  // make the project check-red already, but generation does not read
  // diagnostics, so without this it spends model minutes on whichever
  // recording sorted first and then writes that arbitrary choice down as
  // provenance (#61 review).
  if (found.matches > 1) {
    throw new Error(
      `voice_ref "${ref}" matches ${found.matches} rows in the ${
        found.base === 'shared' ? 'shared' : song
      } ledger — the name has no single meaning; fix the duplicate (field check)`,
    );
  }
  if (found.path === undefined) {
    throw new Error(`voice_ref "${ref}" ${found.problem}`);
  }
  // Copy, then hash the copy. Hashing the original first and copying
  // after would leave the same window one step smaller.
  const path = join(into, `voice-ref${extname(found.asset.file)}`);
  copyFileSync(found.path, path);
  const sha256 = await sha256File(path);
  if (sha256 !== found.asset.sha256) {
    throw new Error(
      `voice_ref "${ref}" does not match its recorded sha256 — the reference recording ` +
        `changed under its ledger entry; refusing to generate from it (field check)`,
    );
  }
  return { path, sha256 };
}

export async function generateVariants(
  root: string,
  name: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const kind = generationKind(options);
  if (!isSlug(name)) throw new Error(`sound name "${name}" must be a lowercase-slug`);
  if (name === RESERVED_LABEL_NAME) {
    throw new Error(`"${RESERVED_LABEL_NAME}" is reserved by the label grammar`);
  }
  if (!isSlug(options.song)) throw new Error(`song "${options.song}" must be a lowercase-slug`);

  const project = loadProject(root);
  if (!project.songs.some((s) => s.name === options.song)) {
    throw new Error(`no such song "${options.song}"`);
  }
  // Musical time projects CLI-side; the worker never learns what a bar
  // is. Only music asks for it: a voice line's length follows from its
  // text (voice-generation.md §1.6), so a voice generate needs no tempo
  // map and does not fail for want of one.
  let durationSeconds: number | undefined;
  let bpm: number | undefined;
  if (kind === 'music') {
    const time = songTime(project, options.song);
    durationSeconds =
      options.durationSeconds ?? time.tempoMap.ticksToSeconds(options.bars! * time.ticksPerBar);
    // The model wants a whole-number hint; ramped songs get their opening tempo.
    bpm = options.bpm ?? Math.round(time.initialBpm);
  }

  const songDir = join(root, 'songs', options.song);
  const outputDir = join(songDir, 'audio', name);
  const recipeAbsolute = join(songDir, 'sounds', `${name}.yaml`);
  if (existsSync(recipeAbsolute)) {
    throw new Error(`sound "${name}" already exists in ${options.song} (pick a new name)`);
  }
  // One namespace per song (§4.3): everything this run will mint — the
  // sound's name AND its <name>-<n> audition labels — must be free, or
  // the model-minutes get spent and the project lands check-red.
  const taken = takenSongNames(songDir);
  const minted = [name, ...Array.from({ length: options.variants }, (_, i) => `${name}-${i + 1}`)];
  const collision = minted.find((n) => taken.has(n));
  if (collision !== undefined) {
    throw new Error(
      `"${collision}" is already a name in ${options.song} — a song's names are one ` +
        `namespace, and generating "${name}" with ${options.variants} variants would mint it ` +
        `(pick a new name)`,
    );
  }
  // The reference recording, snapshotted before the worker starts: a
  // name in the song's namespace becomes the bytes the model reads and
  // the hash the recipe records — the same bytes, which is the point of
  // taking a copy. Everything here is a refusal rather than a repair,
  // because a voice generate that guesses is one that commits audio in a
  // voice nobody asked for.
  //
  // Outside the project deliberately: the snapshot is scaffolding for one
  // run, and a stray copy under songs/ would be a file `field check` has
  // opinions about and a person would have to delete.
  const scratch = options.voiceRef === undefined ? undefined : mkdtempSync(join(tmpdir(), 'field-voice-ref-'));
  try {
    const reference =
      options.voiceRef === undefined
        ? undefined
        : await snapshotVoiceRef(project, options.song, options.voiceRef, scratch!);
    mkdirSync(outputDir, { recursive: true });

    const client =
      kind === 'voice' ? await VoicedClient.connect(root) : await AcedClient.connect(root);
    try {
      client.on('event', (e: { event: string; stage?: string }) => {
        if (e.event === 'progress' && e.stage) options.onProgress?.(e.stage);
      });
      const response =
        client instanceof VoicedClient
          ? await client.generate({
              text: options.text!,
              seed: options.seed,
              variants: options.variants,
              output_dir: outputDir,
              // Omitted, never empty: "" and absent are different requests
              // and only one of them means the model's own voice (#60).
              ...(reference !== undefined ? { voice_ref: reference.path } : {}),
              ...(options.exaggeration !== undefined
                ? { exaggeration: options.exaggeration }
                : {}),
              ...(options.conviction !== undefined ? { conviction: options.conviction } : {}),
            })
          : await client.generate({
              prompt: options.prompt!,
              duration_seconds: durationSeconds!,
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
      // emit a target `field check` would reject — and canonicalized so
      // `field fmt` is a no-op on fresh recipes.
      const recipe = generativeSoundSchema.parse({
        name,
        type: 'generative',
        model: response.model,
        // The kind split, written out: whichever half this run is not, its
        // fields are absent rather than undefined-valued, because a strict
        // schema counts a present key.
        ...(kind === 'voice'
          ? {
              text: options.text,
              ...(reference !== undefined
                ? { voice_ref: options.voiceRef, voice_ref_sha256: reference.sha256 }
                : {}),
              ...(options.exaggeration !== undefined
                ? { exaggeration: options.exaggeration }
                : {}),
              ...(options.conviction !== undefined ? { conviction: options.conviction } : {}),
            }
          : {
              prompt: options.prompt,
              ...(options.lyrics !== undefined ? { lyrics: options.lyrics } : {}),
              bpm,
              duration_seconds: Number(durationSeconds!.toFixed(3)),
              ...(options.bars !== undefined ? { bars: options.bars } : {}),
            }),
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
        voiceRef: options.voiceRef,
      };
    } finally {
      client.close();
    }
  } finally {
    // The snapshot is scaffolding for one run, and the recipe now
    // carries its hash — so nothing downstream needs the copy.
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
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
    throw new Error(`sound ${name}.yaml is invalid; fix it before choosing (field check)`);
  }
  if (recipe.data.type !== 'generative') {
    throw new Error(
      `"${name}" is a ${recipe.data.type} sound — only deliberate generative sounds have variants to choose`,
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
      `variant ${options.variant} does not match its recorded sha256 — refusing to choose (field check)`,
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
// each worker env. The multi-GB weights download happens on the first
// generate of that kind, announced by its progress events.
// Every generation worker, and the list a new one cannot be left out
// of: `field setup <name>` resolves through it, so a worker missing
// here is a worker nobody can install. Exported because that makes it
// the canonical list, and anything else enumerating workers should
// read it rather than keep a copy in step by hand (#67 review).
export const SETUP_SPECS: WorkerSpec[] = [ACED_SPEC, VOICED_SPEC];

export async function setupWorker(
  onLine: (line: string) => void,
  which?: string | undefined,
): Promise<void> {
  const specs =
    which === undefined
      ? SETUP_SPECS
      : SETUP_SPECS.filter((s) => s.packageDir === which || s.name === which);
  if (specs.length === 0) {
    throw new Error(
      `unknown worker "${which}" — try ${SETUP_SPECS.map((s) => s.packageDir).join(' or ')}`,
    );
  }
  for (const spec of specs) {
    // The package, not the environment: creating the environment is what
    // this command is for, so asking whether it exists first would make
    // setup impossible to run once.
    const present = workerPackagePresent(spec);
    if (!present.ok) throw new Error(present.reason ?? `${spec.name} unavailable`);
    // fileURLToPath, not URL.pathname: the latter hands back a
    // percent-encoded path, so a checkout under a directory with a space
    // in it pointed uv at somewhere that does not exist.
    const project = fileURLToPath(new URL(`../../python/${spec.packageDir}/`, import.meta.url));
    onLine(`syncing the ${spec.name} environment (uv)…`);
    const { stderr } = await execFileAsync('uv', ['sync', '--project', project], {
      maxBuffer: 10 * 1024 * 1024,
    });
    for (const line of stderr.split('\n').slice(-5)) if (line.trim()) onLine(line);
  }
  onLine(
    'ready — the first `field generate` of each kind downloads that model’s weights ' +
      '(ACE-Step ~10 GB, Chatterbox ~2 GB)',
  );
}
