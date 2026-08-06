import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { PROJECT_MANIFEST } from '../constants.js';
import { wavFrameCount } from '../audio/wav.js';
import { generatorFor } from '../generators/index.js';
import { expandLoop, placedWindow } from '../generators/track-render.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalText, hasAnchorsOrAliases, type KeyOrder } from '../yaml/emit.js';
import { sha256File } from '../hash.js';
import { sharedAssetName } from '../labels.js';
import { checkSource } from '../generators/single-input.js';
import type { SourceNames } from '../generators/types.js';
import {
  arrangementOrder,
  arrangementSchema,
  assetsFileOrder,
  assetsFileSchema,
  mixOrder,
  mixSchema,
  projectOrder,
  projectSchema,
  songOrder,
  songSchema,
  soundOrder,
  soundSchema,
  takeOrder,
  takeSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
  type Arrangement,
  type AssetsFile,
  type BuildableSound,
  type GenerativeSound,
  type Mix,
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
  arrangement?: LoadedFile<Arrangement> | undefined;
  assets?: LoadedFile<AssetsFile> | undefined;
  // One file per authored spec (project-layout.md §1.3, §4): sounds/
  // holds defined sounds — buildable types and deliberate `generate`
  // recipes alike — and mixes/ holds mixes.
  sounds: LoadedFile<Sound>[];
  mixes: LoadedFile<Mix>[];
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
      mixes: [],
      tracks: [],
      takes: [],
    };

    // The pre-2026-08-06 layout is diagnosed, not silently ignored: a
    // leftover list-file or generation/ directory would otherwise just
    // stop contributing targets, which reads as data loss.
    for (const [legacy, replacement] of [
      ['targets.yaml', 'one file per sound in sounds/ (project-layout.md §1.3, §4)'],
      ['mix.yaml', 'one file per mix in mixes/ (project-layout.md §1.3)'],
      ['generation', 'deliberate sounds in sounds/, variants in audio/ (project-layout.md §1.4)'],
    ] as const) {
      if (existsSync(join(dir, legacy))) {
        project.diagnostics.push({
          file: posix.join(song.dir, legacy),
          message: `the old layout is no longer read — ${replacement}`,
        });
      }
    }

    // The casts on time-carrying files (song, arrangement, tracks) are
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

    const arrangementYaml = join(dir, 'arrangement.yaml');
    if (existsSync(arrangementYaml)) {
      song.arrangement = loadFile(project, arrangementYaml, {
        schema: arrangementSchema,
        order: arrangementOrder,
      }) as LoadedFile<Arrangement> | undefined;
    }

    const assetsYaml = join(dir, 'assets.yaml');
    if (existsSync(assetsYaml)) {
      song.assets = loadFile(project, assetsYaml, {
        schema: assetsFileSchema,
        order: assetsFileOrder,
      });
    }

    for (const file of yamlFiles(join(dir, 'sounds'))) {
      const sound = loadFile(project, file, { schema: soundSchema, order: soundOrder });
      if (sound) song.sounds.push(sound);
    }

    for (const file of yamlFiles(join(dir, 'mixes'))) {
      const mix = loadFile(project, file, { schema: mixSchema, order: mixOrder });
      if (mix) song.mixes.push(mix);
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
      s.arrangement,
      s.assets,
      ...s.sounds,
      ...s.mixes,
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
  // (project-layout.md §1.6); its names are what //shared/assets: refs
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
    ): number | undefined => {
      if (!Array.isArray(value)) return value;
      if (!meterMap) {
        push(file, `${what} is musical time but the song has no valid meter map`);
        return undefined;
      }
      try {
        return resolve(meterMap, value);
      } catch (err) {
        push(file, `${what}: ${(err as Error).message}`);
        return undefined;
      }
    };
    const positionTicks = (file: string, what: string, value: number | number[]) =>
      musical(file, what, value, (meter, arr) => meter.positionTicks(arr[0]!, arr[1], arr[2]));
    const spanTicks = (
      file: string,
      what: string,
      value: number | number[] | undefined,
      from: number,
    ) => musical(file, what, value, (meter, arr) => meter.spanTicks(from, arr));

    if (song.song?.data.length !== undefined) {
      const resolved = spanTicks(song.song.path, 'length', song.song.data.length, 0);
      if (resolved !== undefined) {
        if (resolved <= 0) push(song.song.path, 'length resolves to zero ticks');
        else song.song.data.length = resolved;
      }
    }

    if (song.arrangement) {
      const seen = new Set<string>();
      let resolved = true;
      for (const section of song.arrangement.data.sections) {
        if (seen.has(section.name)) {
          push(song.arrangement.path, `duplicate section "${section.name}"`);
        }
        seen.add(section.name);
        const at = positionTicks(
          song.arrangement.path,
          `section "${section.name}" at`,
          section.at,
        );
        if (at === undefined) resolved = false;
        else section.at = at;
      }
      // Ordering is only meaningful once every position resolved.
      if (resolved) {
        let last = -1;
        for (const section of song.arrangement.data.sections) {
          if (section.at <= last && last >= 0) {
            push(song.arrangement.path, `sections must be ordered by position ("${section.name}")`);
          }
          last = section.at;
        }
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
      unchosen: new Set(
        generateSounds.filter((t) => t.sound.chosen === undefined).map((t) => t.sound.name),
      ),
      shared: sharedNames,
    };
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
          push(path, `variant ${i + 1} audition label "${label}" collides with "${label}"`);
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

    // Clip sources resolve like every other source (project-layout.md
    // §4.3, checkSource): a bare name in the song's one namespace, or a
    // shared pin — the whole visibility rule (§1.5) is that no spelling
    // reaches another song. Takes reference assets only: a take is a
    // recording, and its asset is the ledger row import wrote.
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
    const trackNames = new Set<string>();
    for (const track of song.tracks) {
      const expected = basename(track.path, '.yaml');
      if (track.data.name !== expected) {
        push(track.path, `name "${track.data.name}" must match filename "${expected}"`);
      }
      trackNames.add(track.data.name);

      const trackCtx = {
        root: project.root,
        songDir: song.dir,
        names,
        push: (message: string) => push(track.path, message),
        resolveFile: (baseDir: string, file: string) =>
          resolveAssetFile(project.root, baseDir, file),
      };
      const clipIds = new Set<string>();
      for (const clip of track.data.clips) {
        if (clipIds.has(clip.id)) push(track.path, `duplicate clip id "${clip.id}"`);
        clipIds.add(clip.id);
        // The clip's source is an asset, a sound, or a shared pin
        // (mix-assembly.md §5; project-layout.md §4.3) — same resolution,
        // same messages, as a sound's own source.
        checkSource(clip.source, `clip "${clip.id}"`, trackCtx);
        // Musical arrays need the musical anchor: an absolute clip's
        // scalars are samples, and silently converting [9, 2] would be a
        // unit pun, not a convenience. A clip whose time fields fail to
        // resolve skips the numeric checks below — its diagnostic already
        // holds the gate.
        if (
          clip.anchor === 'absolute' &&
          [clip.position, clip.duration, clip.loop?.every].some((v) => Array.isArray(v))
        ) {
          push(
            track.path,
            `clip "${clip.id}" uses musical time on an absolute clip — ` +
              `musical arrays need anchor: musical`,
          );
          continue;
        }
        const pos = positionTicks(track.path, `clip "${clip.id}" position`, clip.position);
        const dur = spanTicks(track.path, `clip "${clip.id}" duration`, clip.duration, pos ?? 0);
        if (pos === undefined || dur === undefined) continue;
        if (dur <= 0) {
          push(track.path, `clip "${clip.id}" duration resolves to zero ticks`);
          continue;
        }
        clip.position = pos;
        clip.duration = dur;
        if (clip.loop?.every !== undefined) {
          const every = spanTicks(track.path, `clip "${clip.id}" loop.every`, clip.loop.every, pos);
          if (every === undefined) continue;
          if (every <= 0) {
            push(track.path, `clip "${clip.id}" loop.every resolves to zero ticks`);
            continue;
          }
          clip.loop.every = every;
        }
        // Loops are diagnosed here in full — running the same expansion the
        // plan will run — because check is the gate: a check-clean project
        // must never fail to construct its graph (#21 review).
        if (clip.loop?.enabled && tempoMap) {
          const loop = clip.loop;
          const committed = fileBySource(clip.source);
          if (committed === undefined && loop.every === undefined) {
            push(
              track.path,
              `clip "${clip.id}" loops a sound — set loop.every ` +
                `(a sound's length is unknown before it builds)`,
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
                  push(track.path, `clip "${clip.id}" loop source: ${(err as Error).message}`);
                }
              } else {
                sourceUnreadable = true; // the source itself is already diagnosed
              }
            }
            if (!sourceUnreadable) {
              try {
                for (const rep of expandLoop(clip, loop, tempoMap, frames)) {
                  // Fades must fit slots (clip-looping.md §3): overlapping
                  // seam fades duck the audio silently — every: 30 at 120 bpm
                  // makes 750-sample slots the default 480+480 outgrows.
                  if (rep.fade_in + rep.fade_out > rep.duration) {
                    push(
                      track.path,
                      `clip "${clip.id}" loop fades (${rep.fade_in} + ${rep.fade_out} samples) ` +
                        `exceed a ${rep.duration}-sample repetition — ` +
                        `shrink loop.fade or lengthen loop.every`,
                    );
                    break;
                  }
                }
              } catch (err) {
                push(track.path, (err as Error).message); // names the clip itself
              }
            }
          }
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
    // graph node yet. One mix per file, so the filesystem is the duplicate
    // check; the name must match the filename like everything else.
    if (song.mixes.length > 0) {
      const mixable = new Set(
        song.tracks
          .filter((t) => t.data.type === 'audio' && t.data.clips.length > 0)
          .map((t) => t.data.name),
      );
      for (const file of song.mixes) {
        const mix = file.data;
        const expected = basename(file.path, '.yaml');
        if (mix.name !== expected) {
          push(file.path, `name "${mix.name}" must match filename "${expected}"`);
        }
        if (!mix.tracks) continue;
        const listed = new Set<string>();
        for (const trackName of mix.tracks) {
          if (listed.has(trackName)) {
            push(file.path, `mix "${mix.name}" lists track "${trackName}" twice`);
          }
          listed.add(trackName);
          if (!trackNames.has(trackName)) {
            push(file.path, `mix "${mix.name}" references unknown track "${trackName}"`);
          } else if (!mixable.has(trackName)) {
            push(file.path, `mix "${mix.name}" track "${trackName}" has no audio clips to mix`);
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
      if (!assetNames.has(take.data.asset)) {
        push(take.path, `take references unknown asset "${take.data.asset}"`);
      }

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
