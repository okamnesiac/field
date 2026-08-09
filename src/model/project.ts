import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { PROJECT_MANIFEST } from '../constants.js';
import { wavFrameCount } from '../audio/wav.js';
import { generatorFor } from '../generators/index.js';
import { entryRef, expandLoop, generatorName, placedWindow } from '../generators/stem.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalText, hasAnchorsOrAliases, type KeyOrder } from '../yaml/emit.js';
import { sha256File } from '../hash.js';
import { sharedAssetName, SONG_OUTPUT_NAME } from '../labels.js';
import type { SourceNames } from '../generators/types.js';
import {
  assetsFileOrder,
  assetsFileSchema,
  projectOrder,
  projectSchema,
  songOrder,
  songSchema,
  generativeTakesOrder,
  generativeTakesSchema,
  soundOrder,
  soundSchema,
  TAKES_FILENAME,
  takeOrder,
  takeSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
  type Asset,
  type AssetsFile,
  type BuildableSound,
  type GenerativeSound,
  type GenerativeTakes,
  type Project,
  type Song,
  type Sound,
  type Take,
  type TempoFile,
  type Track,
} from '../schema/index.js';

export interface Diagnostic {
  file: string; // project-relative path
  message: string;
}

// Every loaded file carries the KeyOrder it was validated under, so
// formatting decisions never re-infer a file's role from its path.
export interface LoadedFile<T> {
  path: string; // project-relative
  data: T;
  raw: string;
  order: KeyOrder;
}

export interface LoadedSong {
  name: string;
  dir: string; // project-relative
  song?: LoadedFile<Song> | undefined;
  tempo?: LoadedFile<TempoFile> | undefined;
  assets?: LoadedFile<AssetsFile> | undefined;
  // One file per authored spec (project-layout.md §1.3, §4): sounds/
  // holds defined sounds — buildable types and deliberate `generate`
  // recipes alike.
  sounds: LoadedFile<Sound>[];
  tracks: LoadedFile<Track>[];
  takes: LoadedFile<Take>[];
}

export interface LoadedProject {
  root: string; // absolute
  manifest?: LoadedFile<Project> | undefined;
  // shared/assets.yaml — the shared scope's ledger, same shape as a
  // song's, paths relative to shared/ (project-layout.md §1.6).
  shared?: LoadedFile<AssetsFile> | undefined;
  songs: LoadedSong[];
  diagnostics: Diagnostic[];
}

export function findProjectRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, PROJECT_MANIFEST))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

interface FileSpec<T> {
  schema: z.ZodType<T>;
  order: KeyOrder;
}

function loadFile<T>(
  project: LoadedProject,
  absPath: string,
  spec: FileSpec<T>,
): LoadedFile<T> | undefined {
  const path = relative(project.root, absPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    project.diagnostics.push({ file: path, message: `unreadable: ${(err as Error).message}` });
    return undefined;
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    project.diagnostics.push({ file: path, message: `invalid YAML: ${doc.errors[0]!.message}` });
    return undefined;
  }
  if (hasAnchorsOrAliases(doc)) {
    project.diagnostics.push({
      file: path,
      message: 'anchors and aliases are not allowed in project files',
    });
    return undefined;
  }
  const parsed = spec.schema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      project.diagnostics.push({ file: path, message: `${issue.message}${at}` });
    }
    return undefined;
  }
  return { path, data: parsed.data, raw, order: spec.order };
}

// Dotfiles are editor debris, not project files: Emacs writes a dangling
// symlink named `.#track.yaml` while a buffer is unsaved, which ends in
// .yaml and would otherwise be loaded — under `build --watch` that turns
// simply opening a file into a load error (#34 review footnote).
function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
    .sort()
    .map((f) => join(dir, f));
}

// The takes beside a generative sound's audio, if a run has happened.
// Absent is not a diagnostic: a recipe with no takes is a request rather
// than a broken record (bloom-in-tree.md §3), and `build` is what refuses.
// A malformed one *is* diagnosed, against its own path, so the message
// points at the file you would edit.
export function takesPath(songDir: string, soundName: string): string {
  return join(songDir, 'audio', soundName, TAKES_FILENAME);
}

function loadTakes(
  project: LoadedProject,
  songDirAbs: string,
  soundName: string,
): GenerativeTakes | undefined {
  const abs = takesPath(songDirAbs, soundName);
  if (!existsSync(abs)) return undefined;
  const loaded = loadFile(project, abs, {
    schema: generativeTakesSchema,
    order: generativeTakesOrder,
  });
  if (!loaded) return undefined;
  // Same rule a sound's `name` obeys against its filename: a file that has
  // been moved should say so rather than quietly describe another sound.
  if (loaded.data.sound !== soundName) {
    project.diagnostics.push({
      file: loaded.path,
      message: `takes name "${loaded.data.sound}" must match the directory audio/${soundName}/`,
    });
    return undefined;
  }
  return loaded.data;
}

export function loadProject(root: string): LoadedProject {
  const project: LoadedProject = { root: resolve(root), songs: [], diagnostics: [] };

  project.manifest = loadFile(project, join(project.root, PROJECT_MANIFEST), {
    schema: projectSchema,
    order: projectOrder,
  });

  const sharedAssets = join(project.root, 'shared', 'assets.yaml');
  if (existsSync(sharedAssets)) {
    project.shared = loadFile(project, sharedAssets, {
      schema: assetsFileSchema,
      order: assetsFileOrder,
    });
  }

  const songsDir = join(project.root, 'songs');
  const songDirs = existsSync(songsDir)
    ? readdirSync(songsDir)
        .sort()
        .map((name) => join(songsDir, name))
        .filter((p) => statSync(p).isDirectory())
    : [];

  for (const dir of songDirs) {
    const song: LoadedSong = {
      name: basename(dir),
      dir: relative(project.root, dir),
      sounds: [],
      tracks: [],
      takes: [],
    };

    // The pre-2026-08-06 layout is diagnosed, not silently ignored: a
    // leftover list-file or generation/ directory would otherwise just
    // stop contributing targets, which reads as data loss.
    for (const [legacy, replacement] of [
      ['targets.yaml', 'one file per sound in sounds/ (project-layout.md §1.3, §4)'],
      ['generation', 'deliberate sounds in sounds/, variants in audio/ (project-layout.md §1.4)'],
      // Still diagnosed, but no longer pointed at mixes/: that shelf
      // retired too, so the advice this used to give is now a second dead
      // end rather than a migration.
      ['mix.yaml', 'the song\'s output is the track named "main" (nested-tracks.md §7 chunk 2)'],
      // Sections were a stored copy of the structure, and a stored copy
      // drifts: creek's said `chorus` at bar 13 of a twelve-bar song.
      // `field arrangement <song>` derives the same list from the root
      // track's placements, where it cannot (nested-tracks.md §5, §11).
      ['arrangement.yaml', 'the arrangement is derived — run `field arrangement <song>` (nested-tracks.md §11)'],
    ] as const) {
      if (existsSync(join(dir, legacy))) {
        project.diagnostics.push({
          file: posix.join(song.dir, legacy),
          message: `the old layout is no longer read — ${replacement}`,
        });
      }
    }

    // The casts on time-carrying files (song, tracks) are
    // the load boundary of musical-time.md §1.6: their schemas parse the
    // file types, whose time fields may be [bar, beat?, tick?] arrays;
    // validate() resolves every array to a tick scalar (or diagnoses)
    // before loadProject returns, which is what makes the resolved types
    // true for every caller.
    const songYaml = join(dir, 'song.yaml');
    if (existsSync(songYaml)) {
      song.song = loadFile(project, songYaml, { schema: songSchema, order: songOrder }) as
        | LoadedFile<Song>
        | undefined;
    } else {
      project.diagnostics.push({ file: song.dir, message: 'missing song.yaml' });
    }

    const tempoYaml = join(dir, 'tempo.yaml');
    if (existsSync(tempoYaml)) {
      song.tempo = loadFile(project, tempoYaml, { schema: tempoFileSchema, order: tempoFileOrder });
    } else {
      project.diagnostics.push({ file: song.dir, message: 'missing tempo.yaml' });
    }


    const assetsYaml = join(dir, 'assets.yaml');
    if (existsSync(assetsYaml)) {
      song.assets = loadFile(project, assetsYaml, {
        schema: assetsFileSchema,
        order: assetsFileOrder,
      });
    }

    for (const file of yamlFiles(join(dir, 'sounds'))) {
      const parsed = loadFile(project, file, { schema: soundSchema, order: soundOrder });
      if (!parsed) continue;
      if (parsed.data.type !== 'generative') {
        song.sounds.push(parsed as LoadedFile<Sound>);
        continue;
      }
      // A generative sound is its recipe plus whatever takes exist beside
      // its audio (bloom-in-tree.md §7). Merged here, once, so nothing
      // downstream has to know the two are separate files — and absent is
      // a legal answer, meaning nothing has been generated yet.
      const takes = loadTakes(project, dir, parsed.data.name);
      song.sounds.push({
        ...parsed,
        data: { ...parsed.data, variants: takes?.variants ?? [], chosen: takes?.chosen },
      } as LoadedFile<Sound>);
    }

    for (const file of yamlFiles(join(dir, 'tracks'))) {
      const track = loadFile(project, file, { schema: trackSchema, order: trackOrder }) as
        | LoadedFile<Track>
        | undefined;
      if (track) song.tracks.push(track);
    }

    const takesDir = join(dir, 'takes');
    if (existsSync(takesDir)) {
      for (const trackDir of readdirSync(takesDir).sort()) {
        const p = join(takesDir, trackDir);
        if (!statSync(p).isDirectory()) continue;
        for (const file of yamlFiles(p)) {
          const take = loadFile(project, file, { schema: takeSchema, order: takeOrder });
          if (take) song.takes.push(take);
        }
      }
    }

    project.songs.push(song);
  }

  validate(project);
  return project;
}

// Every loaded file in declaration order, for generic passes like
// formatting checks.
export function allFiles(project: LoadedProject): LoadedFile<unknown>[] {
  const files: (LoadedFile<unknown> | undefined)[] = [
    project.manifest,
    project.shared,
    ...project.songs.flatMap((s): (LoadedFile<unknown> | undefined)[] => [
      s.song,
      s.tempo,
      s.assets,
      ...s.sounds,
      ...s.tracks,
      ...s.takes,
    ]),
  ];
  return files.filter((f) => f !== undefined);
}

// Semantic checks beyond per-file schemas: identity rules, tempo/meter
// validity, referential integrity, and canonical formatting.
function validate(project: LoadedProject): void {
  const push = (file: string, message: string) => project.diagnostics.push({ file, message });

  // The shared ledger validates like a song's, against its own scope root
  // (project-layout.md §1.6); its names are what //shared/asset: refs
  // resolve against below.
  const sharedNames = new Set<string>();
  const sharedFileByName = new Map<string, string>();
  if (project.shared) {
    for (const asset of project.shared.data.assets) {
      if (sharedNames.has(asset.name)) {
        push(project.shared.path, `duplicate asset "${asset.name}"`);
      }
      sharedNames.add(asset.name);
      sharedFileByName.set(asset.name, asset.file);
      if (asset.file !== posix.normalize(asset.file) || asset.file.includes('\\')) {
        push(
          project.shared.path,
          `asset "${asset.name}" file path not in normalized form: ${asset.file}`,
        );
      }
      const resolved = resolveAssetFile(project.root, 'shared', asset.file);
      if (resolved.problem) {
        push(project.shared.path, `asset "${asset.name}" ${resolved.problem}`);
      }
    }
  }

  for (const song of project.songs) {
    if (song.song && song.song.data.name !== song.name) {
      push(song.song.path, `name "${song.song.data.name}" must match directory "${song.name}"`);
    }
    if (song.song?.data.loop === true && song.song.data.length === undefined) {
      push(song.song.path, 'loop needs a declared length — the loop point is the length');
    }

    let tempoMap: TempoMap | undefined;
    let meterMap: MeterMap | undefined;
    if (song.tempo) {
      try {
        tempoMap = new TempoMap(song.tempo.data.tempo, project.manifest?.data.sample_rate ?? 48000);
      } catch (err) {
        push(song.tempo.path, (err as Error).message);
      }
      try {
        meterMap = new MeterMap(song.tempo.data.meter);
      } catch (err) {
        push(song.tempo.path, (err as Error).message);
      }
    }

    // Musical time arrays resolve to tick scalars here, at the load
    // boundary (musical-time.md §1.5–1.6): the schema admits the
    // [bar, beat?, tick?] shapes, the meter map gives them meaning, and
    // everything downstream — the rest of validate included — sees only
    // ticks. The resolved types exported from schemas.ts are this pass's
    // promise, which is why a failed resolution always pushes a
    // diagnostic: nothing past the check gate may meet an array.
    const musical = (
      file: string,
      what: string,
      value: number | number[] | undefined,
      resolve: (meter: MeterMap, arr: number[]) => number,
      // The map to read this file's musical time under — the song's, or a
      // track's own (nested-tracks.md §13). Passed rather than defaulted:
      // `undefined` means *no valid map applies*, which a track with a
      // broken local map reaches as surely as a song with a broken
      // tempo.yaml. Falling back to the song's there would resolve the
      // positions against a map the author did not write, inventing
      // numbers on top of an error that was already reported.
      meter: MeterMap | undefined,
    ): number | undefined => {
      if (!Array.isArray(value)) return value;
      if (!meter) {
        push(file, `${what} is musical time but no valid meter map applies`);
        return undefined;
      }
      try {
        return resolve(meter, value);
      } catch (err) {
        push(file, `${what}: ${(err as Error).message}`);
        return undefined;
      }
    };
    const positionTicks = (
      file: string,
      what: string,
      value: number | number[],
      map: MeterMap | undefined,
    ) =>
      musical(file, what, value, (meter, arr) => meter.positionTicks(arr[0]!, arr[1], arr[2]), map);
    const spanTicks = (
      file: string,
      what: string,
      value: number | number[] | undefined,
      from: number,
      map: MeterMap | undefined,
    ) => musical(file, what, value, (meter, arr) => meter.spanTicks(from, arr), map);

    if (song.song?.data.length !== undefined) {
      const resolved = spanTicks(song.song.path, 'length', song.song.data.length, 0, meterMap);
      if (resolved !== undefined) {
        if (resolved <= 0) push(song.song.path, 'length resolves to zero ticks');
        else song.song.data.length = resolved;
      }
    }

    const assetNames = new Set<string>();
    if (song.assets) {
      for (const asset of song.assets.data.assets) {
        if (assetNames.has(asset.name)) {
          push(song.assets.path, `duplicate asset "${asset.name}"`);
        }
        assetNames.add(asset.name);
        // Normalized form required (§3.6 flavor, deferred from #5): with
        // exactly one spelling per path, exact-string comparisons are sound
        // everywhere.
        if (asset.file !== posix.normalize(asset.file) || asset.file.includes('\\')) {
          push(
            song.assets.path,
            `asset "${asset.name}" file path not in normalized form: ${asset.file}`,
          );
        }
        const resolved = resolveAssetFile(project.root, song.dir, asset.file);
        if (resolved.problem) {
          push(song.assets.path, `asset "${asset.name}" ${resolved.problem}`);
        }
      }
    }

    // Defined sounds are one file each, name matching filename
    // (project-layout.md §1.3, §4). Names are collected first, in full:
    // sources may reference sounds declared in other files, and forward
    // references are fine. Deliberate `generate` sounds share the
    // namespace but not the machinery — no Generator, no cycle
    // participation — and mint per-variant audition labels (<name>-<n>)
    // that must not collide with other sounds.
    const soundNames = new Set<string>();
    const buildableSounds: { path: string; sound: BuildableSound }[] = [];
    const generateSounds: { path: string; sound: GenerativeSound }[] = [];
    for (const file of song.sounds) {
      const expected = basename(file.path, '.yaml');
      if (file.data.name !== expected) {
        push(file.path, `name "${file.data.name}" must match filename "${expected}"`);
      }
      if (soundNames.has(file.data.name)) {
        push(file.path, `duplicate sound "${file.data.name}"`);
      }
      soundNames.add(file.data.name);
      // One namespace per song (§4.3): `source: pad` must mean exactly
      // one thing, so a sound may not shadow an asset.
      if (assetNames.has(file.data.name)) {
        push(
          file.path,
          `sound "${file.data.name}" collides with an asset of the same name — ` +
            `a song's names are one namespace (project-layout.md §4.3)`,
        );
      }
      if (file.data.type === 'generative') {
        generateSounds.push({ path: file.path, sound: file.data });
      } else {
        buildableSounds.push({ path: file.path, sound: file.data });
      }
    }
    const names: SourceNames = {
      assets: assetNames,
      sounds: new Set(buildableSounds.map((t) => t.sound.name)),
      chosen: new Set(
        generateSounds.filter((t) => t.sound.chosen !== undefined).map((t) => t.sound.name),
      ),
      // A recipe with no takes is the shape a project ships in when its
      // audio is not committed (bloom-in-tree.md §2.4): well-formed, and
      // simply not filled in yet. Takes with nothing picked is a different
      // thing — `field generate` chooses its first take, so no command
      // produces that state and reaching it means a hand edit.
      ungenerated: new Set(
        generateSounds.filter((t) => t.sound.variants.length === 0).map((t) => t.sound.name),
      ),
      unchosen: new Set(
        generateSounds
          .filter((t) => t.sound.chosen === undefined && t.sound.variants.length > 0)
          .map((t) => t.sound.name),
      ),
      shared: sharedNames,
    };
    // A voice recipe's reference recording must resolve, and to a
    // *committed asset* rather than to any visible name: §1.3's argument
    // for a recording over a vendor's voice ID is provenance, and a
    // generated sound cannot carry that. Absent `voice_ref` is the
    // default-voice case and is deliberately fine (§6).
    for (const { path, sound } of generateSounds) {
      if (sound.voice_ref === undefined) continue;
      // Through lookupAsset, not the name sets, so this pass and `field
      // generate` cannot answer "which asset is this" differently. An
      // asset whose *file* is unresolvable is still found here — the
      // ledger loop above already diagnosed that, and saying it twice
      // would read as two problems.
      if (lookupAsset(project, song.name, sound.voice_ref) === undefined) {
        push(
          path,
          `sound "${sound.name}" voice_ref references unknown asset "${sound.voice_ref}" — ` +
            `a reference recording is a committed asset (voice-generation.md §1.3)`,
        );
      }
    }
    for (const { path, sound } of buildableSounds) {
      // Rule-specific semantics live with the rule (src/generators/).
      generatorFor(sound).validate(sound, {
        root: project.root,
        songDir: song.dir,
        names,
        push: (message) => push(path, `sound "${sound.name}" ${message}`),
        resolveFile: (baseDir, file) => resolveAssetFile(project.root, baseDir, file),
      });
    }
    // Sound→sound references make cycles declarable (effects.md §3);
    // check must name the cycle before the engine's ordering guard ever
    // trips on it. Only buildable-sound sources are edges — assets and
    // chosen variants are committed leaves.
    const byName = new Map(buildableSounds.map(({ sound }) => [sound.name, sound]));
    const pathByName = new Map(buildableSounds.map(({ path, sound }) => [sound.name, path]));
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(name)), name].join(' → ');
        push(pathByName.get(name)!, `sound dependency cycle: ${cycle}`);
        return;
      }
      state.set(name, 'visiting');
      const sound = byName.get(name);
      if (sound) {
        for (const dep of generatorFor(sound).sources(sound)) {
          if (byName.has(dep)) visit(dep, [...path, name]);
        }
      }
      state.set(name, 'done');
    };
    for (const { sound } of buildableSounds) visit(sound.name, []);

    // Deliberate sounds (project-layout.md §1.4): variants are committed,
    // content-addressed artifacts in the song's audio/<name>/ — the
    // containment is also what makes choose's re-choose guard sound — and
    // `chosen` must name a variant that exists.
    for (const { path, sound } of generateSounds) {
      sound.variants.forEach((_, i) => {
        const label = `${sound.name}-${i + 1}`;
        if (soundNames.has(label) || assetNames.has(label)) {
          const what = assetNames.has(label) ? 'asset' : 'sound';
          push(path, `variant ${i + 1} audition label "${label}" collides with the ${what} of that name`);
        }
      });
      const variantFiles = new Set<string>();
      for (const variant of sound.variants) {
        if (variantFiles.has(variant.file)) {
          push(path, `duplicate variant file "${variant.file}"`);
        }
        variantFiles.add(variant.file);
        if (variant.file !== posix.normalize(variant.file) || variant.file.includes('\\')) {
          push(path, `variant file path not in normalized form: ${variant.file}`);
          continue;
        }
        if (!variant.file.startsWith(`audio/${sound.name}/`)) {
          push(path, `variant file must live in audio/${sound.name}/: ${variant.file}`);
        }
        const resolved = resolveAssetFile(project.root, song.dir, variant.file);
        if (resolved.problem) {
          push(path, `variant ${resolved.problem}`);
        }
      }
      if (sound.chosen !== undefined && sound.chosen > sound.variants.length) {
        push(
          path,
          `chosen variant ${sound.chosen} does not exist (${sound.variants.length} variants)`,
        );
      }
    }

    // Entry references resolve per kind, each in its field's own
    // namespace (nested-tracks.md §18) — the whole visibility rule
    // (project-layout.md §1.5) is that no spelling reaches another song,
    // and the one cross-scope spelling is `audio: //shared/asset:`.
    // Takes reference assets only: a take is a recording, and its asset
    // is the ledger row import wrote.
    const assetFileByName = new Map(song.assets?.data.assets.map((a) => [a.name, a.file]) ?? []);
    // Where a committed source's bytes live (undefined for buildable
    // sounds): the ledger file, the shared file, or a chosen variant.
    const fileBySource = (ref: string): { base: string; file: string } | undefined => {
      const shared = sharedAssetName(ref);
      if (shared !== undefined) {
        const file = sharedFileByName.get(shared);
        return file !== undefined ? { base: 'shared', file } : undefined;
      }
      const asset = assetFileByName.get(ref);
      if (asset !== undefined) return { base: song.dir, file: asset };
      const generate = generateSounds.find((g) => g.sound.name === ref)?.sound;
      if (generate?.chosen !== undefined) {
        const variant = generate.variants[generate.chosen - 1];
        if (variant) return { base: song.dir, file: variant.file };
      }
      return undefined;
    };
    // `mixes/` retired with the output track (nested-tracks.md §7 chunk 2).
    // A directory still sitting there is a project mid-migration, and
    // silently not reading it is the worst of the three options: the mix
    // it describes would simply stop existing, with the files still on
    // disk saying otherwise.
    if (existsSync(join(project.root, song.dir, 'mixes'))) {
      push(
        join(song.dir, 'mixes'),
        `mixes/ has retired — a song's output is the track named ` +
          `"${SONG_OUTPUT_NAME}" (nested-tracks.md §7 chunk 2). Move each mix's ` +
          `tracks to that track's inputs, carrying each one's gain_db and pan onto ` +
          `its placement, put the master chain in the track's inserts, and delete ` +
          `the directory`,
      );
    }

    // Names first, in full, like sounds: a track may place a track
    // declared in any file, and a forward reference is fine.
    const trackByName = new Map(song.tracks.map((t) => [t.data.name, t.data]));
    const trackPathByName = new Map(song.tracks.map((t) => [t.data.name, t.path]));
    const trackNames = new Set(trackByName.keys());

    // One timeline per track file, resolved once. Both the track loop and
    // the takes loop below read it: a take is a recording *on* a track, so
    // its ticks are in that track's time exactly as a clip's are
    // (nested-tracks.md §13, #95 review).
    const timeByTrack = new Map<
      string,
      { tempo: TempoMap | undefined; meter: MeterMap | undefined }
    >();
    for (const track of song.tracks) {
      let tempo = tempoMap;
      let meter = meterMap;
      const time = track.data.time;
      if (time?.tempo) {
        try {
          tempo = new TempoMap(time.tempo, project.manifest?.data.sample_rate ?? 48000);
        } catch (err) {
          push(track.path, `local tempo: ${(err as Error).message}`);
          tempo = undefined;
        }
      }
      if (time?.meter) {
        try {
          meter = new MeterMap(time.meter);
        } catch (err) {
          push(track.path, `local meter: ${(err as Error).message}`);
          meter = undefined;
        }
      }
      timeByTrack.set(track.data.name, { tempo, meter });
    }
    for (const track of song.tracks) {
      const expected = basename(track.path, '.yaml');
      if (track.data.name !== expected) {
        push(track.path, `name "${track.data.name}" must match filename "${expected}"`);
      }

      // A track's own timeline (nested-tracks.md §1.5, §13). Everything in
      // this file — its clips and the `at` of every track it places — is
      // in this track's time, so one map governs the whole file. Each half
      // falls back to the song's independently: a 7/8 figure at the song's
      // tempo declares a meter and nothing else.
      //
      // The song's maps, not the placing parent's. A track can be placed
      // in two parents (§1.3) and renders once, so "bar 2" inside it has
      // to mean one thing regardless of who consumes it.
      const { tempo: trackTempo, meter: trackMeter } = timeByTrack.get(track.data.name)!;

      // One entry loop (nested-tracks.md §18): what an entry plays is
      // named by its field, so resolution is per kind and never guesses —
      // audio: refuses a name that renders, sound: refuses committed
      // bytes, each pointing at the field that owns the name.
      const entryIds = new Set<string>();
      track.data.inputs.forEach((entry, i) => {
        // Named by id when it has one — ids are optional (§18 decision
        // 3) — else by position and target, the way placements were.
        const target =
          entry.track ?? entry.sound ?? entry.audio ?? (entry.supercollider ? 'supercollider' : '?');
        const what = entry.id !== undefined ? `input "${entry.id}"` : `input ${i + 1} ("${target}")`;
        if (entry.id !== undefined) {
          if (entryIds.has(entry.id)) push(track.path, `duplicate input id "${entry.id}"`);
          entryIds.add(entry.id);
        }
        if (entry.track !== undefined) {
          if (entry.track === track.data.name) {
            // The locally decidable cycle, with its own message —
            // "cycle: a → a" describes the mistake less well than
            // naming it.
            push(track.path, `${what} places this track inside itself`);
            return;
          }
          if (!trackByName.has(entry.track)) {
            // Diagnosed, not fatal to the entry: the time fields still
            // resolve, the way an unknown clip source always worked —
            // one mistake, one message, the rest of the file readable.
            push(track.path, `${what} references unknown track "${entry.track}"`);
          }
        } else if (entry.audio !== undefined) {
          const shared = sharedAssetName(entry.audio);
          if (shared !== undefined) {
            if (!names.shared.has(shared)) {
              push(track.path, `${what} references unknown shared asset "${shared}"`);
            }
          } else if (!names.assets.has(entry.audio)) {
            const rendersInstead =
              names.sounds.has(entry.audio) ||
              names.chosen.has(entry.audio) ||
              names.ungenerated.has(entry.audio) ||
              names.unchosen.has(entry.audio);
            push(
              track.path,
              rendersInstead
                ? `${what} audio: names the sound "${entry.audio}" — a sound is a ` +
                    `definition, not committed bytes; use sound: (nested-tracks.md §18)`
                : `${what} references unknown audio "${entry.audio}"`,
            );
          }
        } else if (entry.sound !== undefined) {
          if (names.unchosen.has(entry.sound)) {
            push(
              track.path,
              `${what} sources "${entry.sound}", which has no chosen variant yet — ` +
                `field choose ${entry.sound} first`,
            );
          }
          if (
            !names.sounds.has(entry.sound) &&
            !names.chosen.has(entry.sound) &&
            // Unchosen is a state of a sound that exists — it got its own
            // diagnostic above, and "unknown" on top of it would be false.
            !names.unchosen.has(entry.sound) &&
            !names.ungenerated.has(entry.sound)
          ) {
            push(
              track.path,
              names.assets.has(entry.sound)
                ? `${what} sound: names the asset "${entry.sound}" — committed bytes ` +
                    `are audio:'s to name (nested-tracks.md §18)`
                : `${what} references unknown sound "${entry.sound}"`,
            );
          }
        } else if (entry.supercollider !== undefined) {
          // The generator's own rule validates the entry the way it
          // validates a sound file — same program-path resolution, same
          // messages — against a spec built exactly as buildGraph builds
          // it, so the two sites cannot answer differently.
          const spec = {
            name: generatorName(entry, track.data.name),
            type: 'supercollider' as const,
            ...entry.supercollider,
          };
          generatorFor(spec).validate(spec, {
            root: project.root,
            songDir: song.dir,
            names,
            push: (message: string) => push(track.path, `${what} ${message}`),
            resolveFile: (baseDir: string, file: string) =>
              resolveAssetFile(project.root, baseDir, file),
          });
        }
        // Musical arrays need the musical anchor: an absolute entry's
        // scalars are samples, and silently converting [9, 2] would be a
        // unit pun, not a convenience. An entry whose time fields fail to
        // resolve skips the numeric checks below — its diagnostic already
        // holds the gate.
        if (
          entry.anchor === 'absolute' &&
          [entry.at, entry.duration, entry.loop?.every].some((v) => Array.isArray(v))
        ) {
          push(
            track.path,
            `${what} uses musical time on an absolute entry — ` +
              `musical arrays need anchor: musical`,
          );
          return;
        }
        const pos = positionTicks(track.path, `${what} at`, entry.at, trackMeter);
        if (pos === undefined) return;
        entry.at = pos;
        // An *absent* duration is the entry declining to truncate, and has
        // to be told apart from one that failed to resolve: the second
        // already pushed a diagnostic and must skip the checks below,
        // while the first is a valid entry that still has to pass them.
        // Collapsing the two would let `duration:` be omitted and take
        // every remaining check with it.
        if (entry.duration !== undefined) {
          const dur = spanTicks(track.path, `${what} duration`, entry.duration, pos, trackMeter);
          if (dur === undefined) return;
          if (dur <= 0) {
            push(track.path, `${what} duration resolves to zero ticks`);
            return;
          }
          entry.duration = dur;
        } else if (entry.loop?.enabled) {
          // A loop tiles a window, so it needs one (clip-looping.md §1).
          // "As long as the source" and "repeat to fill the window" are
          // contrary instructions, not a default and an override.
          push(
            track.path,
            `${what} loops but declares no duration — a loop tiles a window, ` +
              `so give it a duration or drop the loop`,
          );
          return;
        }
        if (entry.loop?.every !== undefined) {
          const every = spanTicks(track.path, `${what} loop.every`, entry.loop.every, pos, trackMeter);
          if (every === undefined) return;
          if (every <= 0) {
            push(track.path, `${what} loop.every resolves to zero ticks`);
            return;
          }
          entry.loop.every = every;
        }
        // Loops are diagnosed here in full — running the same expansion the
        // plan will run — because check is the gate: a check-clean project
        // must never fail to construct its graph (#21 review).
        if (entry.loop?.enabled && trackTempo) {
          const loop = entry.loop;
          const committed = fileBySource(entryRef(entry, track.data.name));
          if (committed === undefined && loop.every === undefined) {
            const kind =
              entry.track !== undefined
                ? 'track'
                : entry.supercollider !== undefined
                  ? 'generator'
                  : 'sound';
            push(
              track.path,
              `${what} loops a ${kind} — set loop.every ` +
                `(a ${kind}'s length is unknown before it builds)`,
            );
          } else {
            // Tiling at source length needs the frame count; the seek-based
            // header read costs no audio bytes (wav.ts).
            let frames: number | undefined;
            let sourceUnreadable = false;
            if (committed !== undefined && loop.every === undefined) {
              const resolved = resolveAssetFile(project.root, committed.base, committed.file);
              if (resolved.path) {
                try {
                  frames = wavFrameCount(resolved.path);
                } catch (err) {
                  sourceUnreadable = true;
                  push(track.path, `${what} loop source: ${(err as Error).message}`);
                }
              } else {
                sourceUnreadable = true; // the source itself is already diagnosed
              }
            }
            if (!sourceUnreadable) {
              try {
                for (const rep of expandLoop(entry, loop, trackTempo, frames)) {
                  // Fades must fit slots (clip-looping.md §3): overlapping
                  // seam fades duck the audio silently — every: 30 at 120 bpm
                  // makes 750-sample slots the default 480+480 outgrows.
                  if (rep.fade_in + rep.fade_out > rep.duration) {
                    push(
                      track.path,
                      `${what} loop fades (${rep.fade_in} + ${rep.fade_out} samples) ` +
                        `exceed a ${rep.duration}-sample repetition — ` +
                        `shrink loop.fade or lengthen loop.every`,
                    );
                    break;
                  }
                }
              } catch (err) {
                push(track.path, (err as Error).message); // names the entry itself
              }
            }
          }
        }
        // Fades live inside the window; whether they fit is only known
        // in samples, so musical entries are checked through the tempo map.
        if (trackTempo) {
          const { duration } = placedWindow(entry, trackTempo);
          // An omitted duration has no window until the source renders, so
          // the daemon is the only place that check can happen.
          if (duration !== undefined && entry.fade_in + entry.fade_out > duration) {
            push(
              track.path,
              `${what} fades (${entry.fade_in} + ${entry.fade_out} samples) ` +
                `exceed its ${duration}-sample window`,
            );
          }
        }
      });

    }

    // A generator entry's render is a node, so it needs a name no other
    // generator claims (nested-tracks.md §18 step 2): the owning track's,
    // or <track>-<id>. Two un-id'd generators in one track collide here,
    // and the fix is the message: give them ids.
    const genNames = new Set<string>();
    for (const trackFile of song.tracks) {
      for (const entry of trackFile.data.inputs) {
        if (entry.supercollider === undefined) continue;
        const name = generatorName(entry, trackFile.data.name);
        if (genNames.has(name)) {
          push(
            trackFile.path,
            `two generator entries share the name "${name}" — give each an id so ` +
              `its render has a name of its own (nested-tracks.md §18)`,
          );
        }
        genNames.add(name);
      }
    }

    // Containment cycles. Sound sources already made cycles declarable
    // (effects.md §3) and this is the same detector for the same reason:
    // check is the gate, so it must name the cycle before the build
    // walker trips over it and reports something about its own ordering.
    // Direct self-placement is diagnosed above and skipped here, so its
    // clearer message is the only one that appears.
    const containmentState = new Map<string, 'visiting' | 'done'>();
    const visitTrack = (name: string, path: string[]): void => {
      if (containmentState.get(name) === 'done') return;
      if (containmentState.get(name) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(name)), name].join(' → ');
        push(trackPathByName.get(name)!, `track containment cycle: ${cycle}`);
        return;
      }
      containmentState.set(name, 'visiting');
      // The entries that are containment edges are exactly the ones that
      // place a track (§18) — audio and generator entries are leaves.
      for (const entry of trackByName.get(name)?.inputs ?? []) {
        if (entry.track !== undefined && entry.track !== name && trackByName.has(entry.track)) {
          visitTrack(entry.track, [...path, name]);
        }
      }
      containmentState.set(name, 'done');
    };
    for (const track of song.tracks) visitTrack(track.data.name, []);

    for (const take of song.takes) {
      // Filenames are keys (project-core.md §6): takes/<track>/<take-id>.yaml.
      const expectedId = basename(take.path, '.yaml');
      if (take.data.id !== expectedId) {
        push(take.path, `id "${take.data.id}" must match filename "${expectedId}"`);
      }
      const dirTrack = basename(dirname(take.path));
      if (take.data.track !== dirTrack) {
        push(take.path, `track "${take.data.track}" must match containing directory "${dirTrack}"`);
      }
      if (!trackNames.has(take.data.track)) {
        push(take.path, `take references unknown track "${take.data.track}"`);
      }
      if (!assetNames.has(take.data.asset)) {
        push(take.path, `take references unknown asset "${take.data.asset}"`);
      }

      // Takes store both time representations under a declared anchor; the
      // derived one must agree with the tempo map (project-core.md §3.1) —
      // the track's own, since that is the timeline the recording sits in.
      // A known track whose local map failed to parse yields `undefined`
      // and skips the check: its error is already reported, and deriving
      // against the song's map would reject samples that are right.
      const onTrack = timeByTrack.get(take.data.track);
      const takeTempo = onTrack ? onTrack.tempo : tempoMap;
      if (takeTempo) {
        if (take.data.anchor === 'musical') {
          const derived = takeTempo.ticksToSamples(take.data.position);
          if (derived !== take.data.position_samples) {
            push(
              take.path,
              `position_samples ${take.data.position_samples} disagrees with tempo map ` +
                `(position ${take.data.position} ticks = ${derived} samples)`,
            );
          }
        } else {
          const derived = takeTempo.samplesToTicks(take.data.position_samples);
          // ±1 tick tolerance: the authoritative samples value rounds to ticks.
          if (Math.abs(derived - take.data.position) > 1) {
            push(
              take.path,
              `position ${take.data.position} disagrees with tempo map ` +
                `(position_samples ${take.data.position_samples} = ${Math.round(derived)} ticks)`,
            );
          }
        }
      }
    }

  }
}

// Resolve an asset's file path safely, or say why it can't be used. The
// single source of truth for asset-path rules — validate diagnoses with the
// problem, and verifyAssetHashes reads only what this accepts, so the two
// passes cannot drift apart.
function resolveAssetFile(
  root: string,
  songDir: string,
  file: string,
): { path?: string; problem?: string } {
  if (isAbsolute(file)) return { problem: `file path must be relative: ${file}` };
  const path = resolve(root, songDir, file);
  if (path !== root && !path.startsWith(root + sep)) {
    return { problem: `file path escapes the project: ${file}` };
  }
  if (!existsSync(path)) return { problem: `file not found: ${file}` };
  if (!statSync(path).isFile()) return { problem: `file is not a regular file: ${file}` };
  return { path };
}

// Resolving a ref that must name a *committed asset* — the rule
// `voice_ref` follows (voice-generation.md §1.3). One function, because
// two passes read it: validate diagnoses a ref that names nothing, and
// `field generate` turns the same ref into the path it feeds the worker
// and the hash it writes into the recipe. Both #58 review findings were
// two readings of "which asset is this" disagreeing — a name resolved in
// the wrong namespace, and a hash that pinned nothing — so the readings
// are one reading now. Bare names are scoped to their song
// (project-layout.md §4.3); `//shared/asset:<name>` crosses scope.
export interface AssetLookup {
  asset: Asset;
  base: string; // scope dir, project-relative — what `asset.file` is relative to
  path?: string | undefined; // absolute, when the file resolves
  problem?: string | undefined; // why it does not, in resolveAssetFile's words
  // How many ledger rows carry this name. A schema-valid ledger can hold
  // two rows called `ref-voice` pointing at different recordings, and
  // validate diagnoses that separately — but `find` would still hand back
  // the first one, so a caller that never looked at diagnostics would act
  // on an arbitrary answer to a question that has none. Being the single
  // reading means reporting that, not resolving it (#61 review): a
  // *lookup* can only say the name is ambiguous, and whether that is
  // fatal is the caller's to decide.
  matches: number;
}

export function lookupAsset(
  project: LoadedProject,
  songName: string,
  ref: string,
): AssetLookup | undefined {
  const shared = sharedAssetName(ref);
  const song = project.songs.find((s) => s.name === songName);
  const scope =
    shared !== undefined
      ? { name: shared, base: 'shared', ledger: project.shared?.data.assets }
      : { name: ref, base: song?.dir ?? '', ledger: song?.assets?.data.assets };
  const matched = scope.ledger?.filter((a) => a.name === scope.name) ?? [];
  const asset = matched[0];
  if (!asset) return undefined;
  return {
    asset,
    base: scope.base,
    matches: matched.length,
    ...resolveAssetFile(project.root, scope.base, asset.file),
  };
}

// Files whose formatting differs from canonical (project-core.md §3.6).
export function unformattedFiles(project: LoadedProject): string[] {
  return allFiles(project)
    .filter((file) => canonicalText(file.raw, file.order) !== file.raw)
    .map((file) => file.path);
}

// Content verification: every declared asset's bytes must match its
// recorded size and hash to its recorded sha256. Separate from loadProject
// because it reads full asset files — check runs it; fmt and status don't
// need it. Only paths resolveAssetFile accepts are read, so unusable paths
// (already diagnosed by validate) are never opened.
export async function verifyAssetHashes(project: LoadedProject): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  // One ledger per scope (project-layout.md §1.6): shared/assets.yaml and
  // each song's assets.yaml verify identically, paths relative to their
  // scope root.
  const ledgers = [
    ...(project.shared ? [{ ledger: project.shared, base: 'shared' }] : []),
    ...project.songs.flatMap((s) => (s.assets ? [{ ledger: s.assets, base: s.dir }] : [])),
  ];
  for (const { ledger, base } of ledgers) {
    for (const asset of ledger.data.assets) {
      const { path } = resolveAssetFile(project.root, base, asset.file);
      if (!path) continue; // already diagnosed by validate
      // Size first: cheaper than hashing, and truncation gets a clearer
      // message than a bare hash mismatch.
      const size = statSync(path).size;
      if (size !== asset.bytes) {
        diagnostics.push({
          file: ledger.path,
          message: `asset "${asset.name}" is ${size} bytes on disk but ${asset.bytes} recorded`,
        });
        continue;
      }
      const actual = await sha256File(path);
      if (actual !== asset.sha256) {
        diagnostics.push({
          file: ledger.path,
          message: `asset "${asset.name}" content does not match its recorded sha256 (${asset.file} hashes to ${actual})`,
        });
      }
    }
  }
  // A voice recipe's reference recording is pinned by hash for the same
  // reason its variants are (voice-generation.md §1.3 and §6). Without
  // this the hash is a field, not a pin: the recording could be swapped
  // under a recipe that still claimed to describe it and the project
  // stayed check-green (#58 review). Compared against the ledger's
  // recorded sha rather than re-hashing, because the loop above has
  // already proved recorded matches actual.
  //
  // Resolved per song through lookupAsset, which is what makes a bare
  // name mean its own song's asset (project-layout.md §4.3). The map this
  // replaced was built once and keyed by bare name, so a later song's
  // `ref-voice` overwrote an earlier song's and a recipe then verified
  // against a recording from a different song entirely — false drift one
  // way, a silent pass the other (#58 review).
  for (const song of project.songs) {
    for (const file of song.sounds) {
      if (file.data.type !== 'generative') continue;
      const { voice_ref: ref, voice_ref_sha256: declared } = file.data;
      if (ref === undefined || declared === undefined) continue;
      const recorded = lookupAsset(project, song.name, ref)?.asset.sha256;
      if (recorded === undefined) continue; // already diagnosed by validate
      if (recorded !== declared) {
        diagnostics.push({
          file: file.path,
          message:
            `voice_ref "${ref}" is recorded as ${recorded} but the recipe declares ` +
            `${declared} — the reference recording changed under the recipe`,
        });
      }
    }
  }
  // Deliberate-target variants are committed artifacts with recorded
  // hashes too (project-layout.md §1.4) — a recipe whose WAVs drifted is
  // provenance that lies, which is the one thing a recipe must never do.
  for (const song of project.songs) {
    for (const file of song.sounds) {
      if (file.data.type !== 'generative') continue;
      for (const variant of file.data.variants) {
        const { path } = resolveAssetFile(project.root, song.dir, variant.file);
        if (!path) continue; // already diagnosed by validate
        const actual = await sha256File(path);
        if (actual !== variant.sha256) {
          diagnostics.push({
            file: file.path,
            message: `variant "${variant.file}" content does not match its recorded sha256 (hashes to ${actual})`,
          });
        }
      }
    }
  }
  return diagnostics;
}
