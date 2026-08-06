import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { PROJECT_MANIFEST } from '../constants.js';
import { ruleImpl } from '../rules/index.js';
import { placedWindow } from '../rules/track-render.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalText, hasAnchorsOrAliases, type KeyOrder } from '../yaml/emit.js';
import { sha256File } from '../hash.js';
import {
  arrangementOrder,
  arrangementSchema,
  assetsFileOrder,
  assetsFileSchema,
  generationRecipeOrder,
  generationRecipeSchema,
  mixFileOrder,
  mixFileSchema,
  projectOrder,
  projectSchema,
  songOrder,
  songSchema,
  takeOrder,
  takeSchema,
  targetsFileOrder,
  targetsFileSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
  type Arrangement,
  type AssetsFile,
  type GenerationRecipe,
  type MixFile,
  type Project,
  type Song,
  type Take,
  type TargetsFile,
  type TempoFile,
  type Track,
} from '../schema/schemas.js';

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
  arrangement?: LoadedFile<Arrangement> | undefined;
  assets?: LoadedFile<AssetsFile> | undefined;
  targets?: LoadedFile<TargetsFile> | undefined;
  mix?: LoadedFile<MixFile> | undefined;
  tracks: LoadedFile<Track>[];
  takes: LoadedFile<Take>[];
  generation: LoadedFile<GenerationRecipe>[];
}

export interface LoadedProject {
  root: string; // absolute
  manifest?: LoadedFile<Project> | undefined;
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

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => join(dir, f));
}

export function loadProject(root: string): LoadedProject {
  const project: LoadedProject = { root: resolve(root), songs: [], diagnostics: [] };

  project.manifest = loadFile(project, join(project.root, PROJECT_MANIFEST), {
    schema: projectSchema,
    order: projectOrder,
  });

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
      tracks: [],
      takes: [],
      generation: [],
    };

    const songYaml = join(dir, 'song.yaml');
    if (existsSync(songYaml)) {
      song.song = loadFile(project, songYaml, { schema: songSchema, order: songOrder });
    } else {
      project.diagnostics.push({ file: song.dir, message: 'missing song.yaml' });
    }

    const tempoYaml = join(dir, 'tempo.yaml');
    if (existsSync(tempoYaml)) {
      song.tempo = loadFile(project, tempoYaml, { schema: tempoFileSchema, order: tempoFileOrder });
    } else {
      project.diagnostics.push({ file: song.dir, message: 'missing tempo.yaml' });
    }

    const arrangementYaml = join(dir, 'arrangement.yaml');
    if (existsSync(arrangementYaml)) {
      song.arrangement = loadFile(project, arrangementYaml, {
        schema: arrangementSchema,
        order: arrangementOrder,
      });
    }

    const assetsYaml = join(dir, 'assets.yaml');
    if (existsSync(assetsYaml)) {
      song.assets = loadFile(project, assetsYaml, {
        schema: assetsFileSchema,
        order: assetsFileOrder,
      });
    }

    const targetsYaml = join(dir, 'targets.yaml');
    if (existsSync(targetsYaml)) {
      song.targets = loadFile(project, targetsYaml, {
        schema: targetsFileSchema,
        order: targetsFileOrder,
      });
    }

    const mixYaml = join(dir, 'mix.yaml');
    if (existsSync(mixYaml)) {
      song.mix = loadFile(project, mixYaml, { schema: mixFileSchema, order: mixFileOrder });
    }

    for (const file of yamlFiles(join(dir, 'tracks'))) {
      const track = loadFile(project, file, { schema: trackSchema, order: trackOrder });
      if (track) song.tracks.push(track);
    }

    for (const file of yamlFiles(join(dir, 'generation'))) {
      const recipe = loadFile(project, file, {
        schema: generationRecipeSchema,
        order: generationRecipeOrder,
      });
      if (recipe) song.generation.push(recipe);
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
    ...project.songs.flatMap((s): (LoadedFile<unknown> | undefined)[] => [
      s.song,
      s.tempo,
      s.arrangement,
      s.assets,
      s.targets,
      s.mix,
      ...s.tracks,
      ...s.takes,
      ...s.generation,
    ]),
  ];
  return files.filter((f) => f !== undefined);
}

// Semantic checks beyond per-file schemas: identity rules, tempo/meter
// validity, referential integrity, and canonical formatting.
function validate(project: LoadedProject): void {
  const push = (file: string, message: string) => project.diagnostics.push({ file, message });

  for (const song of project.songs) {
    if (song.song && song.song.data.name !== song.name) {
      push(song.song.path, `name "${song.song.data.name}" must match directory "${song.name}"`);
    }

    let tempoMap: TempoMap | undefined;
    if (song.tempo) {
      try {
        tempoMap = new TempoMap(song.tempo.data.tempo, project.manifest?.data.sample_rate ?? 48000);
      } catch (err) {
        push(song.tempo.path, (err as Error).message);
      }
      try {
        new MeterMap(song.tempo.data.meter);
      } catch (err) {
        push(song.tempo.path, (err as Error).message);
      }
    }

    if (song.arrangement) {
      const seen = new Set<string>();
      let last = -1;
      for (const section of song.arrangement.data.sections) {
        if (seen.has(section.name)) {
          push(song.arrangement.path, `duplicate section "${section.name}"`);
        }
        seen.add(section.name);
        if (section.at <= last && last >= 0) {
          push(song.arrangement.path, `sections must be ordered by position ("${section.name}")`);
        }
        last = section.at;
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

    const targetNames = new Set<string>();
    if (song.targets) {
      const targetsPath = song.targets.path;
      // Names first, in full: single-input rules may reference targets
      // declared later in the file, and forward references are fine.
      for (const target of song.targets.data.targets) {
        if (targetNames.has(target.name)) {
          push(targetsPath, `duplicate target "${target.name}"`);
        }
        targetNames.add(target.name);
      }
      for (const target of song.targets.data.targets) {
        // Rule-specific semantics live with the rule (src/rules/).
        ruleImpl(target).validate(target, {
          root: project.root,
          songDir: song.dir,
          assetNames,
          targetNames,
          push: (message) => push(targetsPath, `target "${target.name}" ${message}`),
          resolveFile: (baseDir, file) => resolveAssetFile(project.root, baseDir, file),
        });
      }
      // Target→target references make cycles declarable (effects.md §3);
      // check must name the cycle before the engine's ordering guard ever
      // trips on it.
      const byName = new Map(song.targets.data.targets.map((t) => [t.name, t]));
      const state = new Map<string, 'visiting' | 'done'>();
      const visit = (name: string, path: string[]): void => {
        if (state.get(name) === 'done') return;
        if (state.get(name) === 'visiting') {
          const cycle = [...path.slice(path.indexOf(name)), name].join(' → ');
          push(targetsPath, `target dependency cycle: ${cycle}`);
          return;
        }
        state.set(name, 'visiting');
        const target = byName.get(name);
        if (target) {
          for (const dep of ruleImpl(target).targetDeps?.(target) ?? []) {
            if (byName.has(dep)) visit(dep, [...path, name]);
          }
        }
        state.set(name, 'done');
      };
      for (const target of song.targets.data.targets) visit(target.name, []);
    }

    // Clips and takes reference assets by name (readable diffs); the
    // assets.yaml entry carries the content hash.
    const checkAssetRef = (file: string, label: string, name: string) => {
      if (!assetNames.has(name)) {
        push(file, `${label} references unknown asset "${name}"`);
      }
    };

    const trackNames = new Set<string>();
    for (const track of song.tracks) {
      const expected = basename(track.path, '.yaml');
      if (track.data.name !== expected) {
        push(track.path, `name "${track.data.name}" must match filename "${expected}"`);
      }
      trackNames.add(track.data.name);

      const clipIds = new Set<string>();
      for (const clip of track.data.clips) {
        if (clipIds.has(clip.id)) push(track.path, `duplicate clip id "${clip.id}"`);
        clipIds.add(clip.id);
        // Exactly one source per clip (schema-enforced): an asset, or a
        // same-song target whose render the clip plays (mix-assembly.md §5).
        if (clip.asset !== undefined) {
          checkAssetRef(track.path, `clip "${clip.id}"`, clip.asset);
        } else if (clip.target !== undefined && !targetNames.has(clip.target)) {
          push(track.path, `clip "${clip.id}" references unknown target "${clip.target}"`);
        }
        // Fades live inside the clip window; whether they fit is only known
        // in samples, so musical clips are checked through the tempo map.
        if (tempoMap) {
          const { duration } = placedWindow(clip, tempoMap);
          if (clip.fade_in + clip.fade_out > duration) {
            push(
              track.path,
              `clip "${clip.id}" fades (${clip.fade_in} + ${clip.fade_out} samples) ` +
                `exceed its ${duration}-sample window`,
            );
          }
        }
      }
    }

    // Mixes reference tracks that can actually produce stems: audio, with
    // clips (mix-assembly.md §3). Omitted `tracks` means all of them, which
    // may be none — an empty mix is legal (a fresh song), it just has no
    // graph node yet.
    if (song.mix) {
      const mixable = new Set(
        song.tracks
          .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
          .map((t) => t.data.name),
      );
      const mixNames = new Set<string>();
      for (const mix of song.mix.data.mixes) {
        if (mixNames.has(mix.name)) push(song.mix.path, `duplicate mix "${mix.name}"`);
        mixNames.add(mix.name);
        if (!mix.tracks) continue;
        const listed = new Set<string>();
        for (const trackName of mix.tracks) {
          if (listed.has(trackName)) {
            push(song.mix.path, `mix "${mix.name}" lists track "${trackName}" twice`);
          }
          listed.add(trackName);
          if (!trackNames.has(trackName)) {
            push(song.mix.path, `mix "${mix.name}" references unknown track "${trackName}"`);
          } else if (!mixable.has(trackName)) {
            push(
              song.mix.path,
              `mix "${mix.name}" track "${trackName}" has no audio clips to mix`,
            );
          }
        }
      }
    }

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
      checkAssetRef(take.path, 'take', take.data.asset);

      // Takes store both time representations under a declared anchor; the
      // derived one must agree with the tempo map (project-core.md §3.1).
      if (tempoMap) {
        if (take.data.anchor === 'musical') {
          const derived = tempoMap.ticksToSamples(take.data.position);
          if (derived !== take.data.position_samples) {
            push(
              take.path,
              `position_samples ${take.data.position_samples} disagrees with tempo map ` +
                `(position ${take.data.position} ticks = ${derived} samples)`,
            );
          }
        } else {
          const derived = tempoMap.samplesToTicks(take.data.position_samples);
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

    // Generation recipes (ace-generation.md §3.1): filenames are keys like
    // everywhere else, variant files are content-addressed committed
    // artifacts under generation/<name>/, and `chosen` must name a variant
    // that exists.
    for (const recipe of song.generation) {
      const expected = basename(recipe.path, '.yaml');
      if (recipe.data.name !== expected) {
        push(recipe.path, `name "${recipe.data.name}" must match filename "${expected}"`);
      }
      const generationDir = join(song.dir, 'generation');
      const variantFiles = new Set<string>();
      for (const variant of recipe.data.variants) {
        if (variantFiles.has(variant.file)) {
          push(recipe.path, `duplicate variant file "${variant.file}"`);
        }
        variantFiles.add(variant.file);
        if (variant.file !== posix.normalize(variant.file) || variant.file.includes('\\')) {
          push(recipe.path, `variant file path not in normalized form: ${variant.file}`);
        }
        const resolved = resolveAssetFile(project.root, generationDir, variant.file);
        if (resolved.problem) {
          push(recipe.path, `variant ${resolved.problem}`);
        }
      }
      if (recipe.data.chosen !== undefined && recipe.data.chosen > recipe.data.variants.length) {
        push(
          recipe.path,
          `chosen variant ${recipe.data.chosen} does not exist ` +
            `(${recipe.data.variants.length} variants)`,
        );
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
  for (const song of project.songs) {
    if (!song.assets) continue;
    for (const asset of song.assets.data.assets) {
      const { path } = resolveAssetFile(project.root, song.dir, asset.file);
      if (!path) continue; // already diagnosed by validate
      // Size first: cheaper than hashing, and truncation gets a clearer
      // message than a bare hash mismatch.
      const size = statSync(path).size;
      if (size !== asset.bytes) {
        diagnostics.push({
          file: song.assets.path,
          message: `asset "${asset.name}" is ${size} bytes on disk but ${asset.bytes} recorded`,
        });
        continue;
      }
      const actual = await sha256File(path);
      if (actual !== asset.sha256) {
        diagnostics.push({
          file: song.assets.path,
          message: `asset "${asset.name}" content does not match its recorded sha256 (${asset.file} hashes to ${actual})`,
        });
      }
    }
  }
  // Generation variants are committed artifacts with recorded hashes too
  // (ace-generation.md §3.1) — a recipe whose WAVs drifted is provenance
  // that lies, which is the one thing a recipe must never do.
  for (const song of project.songs) {
    for (const recipe of song.generation) {
      for (const variant of recipe.data.variants) {
        const { path } = resolveAssetFile(project.root, join(song.dir, 'generation'), variant.file);
        if (!path) continue; // already diagnosed by validate
        const actual = await sha256File(path);
        if (actual !== variant.sha256) {
          diagnostics.push({
            file: recipe.path,
            message: `variant "${variant.file}" content does not match its recorded sha256 (hashes to ${actual})`,
          });
        }
      }
    }
  }
  return diagnostics;
}
