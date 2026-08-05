import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { z } from 'zod';
import { PROJECT_MANIFEST } from '../constants.js';
import { MeterMap, TempoMap } from '../time/tempo.js';
import { canonicalText, type KeyOrder } from '../yaml/emit.js';
import {
  arrangementOrder,
  arrangementSchema,
  projectOrder,
  projectSchema,
  songOrder,
  songSchema,
  takeOrder,
  takeSchema,
  tempoFileOrder,
  tempoFileSchema,
  trackOrder,
  trackSchema,
  type Arrangement,
  type Project,
  type Song,
  type Take,
  type TempoFile,
  type Track,
} from '../schema/schemas.js';

export interface Diagnostic {
  file: string; // project-relative path
  message: string;
}

export interface LoadedFile<T> {
  path: string; // project-relative
  data: T;
  raw: string;
}

export interface LoadedSong {
  name: string;
  dir: string; // project-relative
  song?: LoadedFile<Song> | undefined;
  tempo?: LoadedFile<TempoFile> | undefined;
  arrangement?: LoadedFile<Arrangement> | undefined;
  tracks: LoadedFile<Track>[];
  takes: LoadedFile<Take>[];
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
  const parsed = spec.schema.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
      project.diagnostics.push({ file: path, message: `${issue.message}${at}` });
    }
    return undefined;
  }
  return { path, data: parsed.data, raw };
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

    for (const file of yamlFiles(join(dir, 'tracks'))) {
      const track = loadFile(project, file, { schema: trackSchema, order: trackOrder });
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

// Semantic checks beyond per-file schemas: identity rules, tempo/meter
// validity, referential integrity, and canonical formatting.
function validate(project: LoadedProject): void {
  const push = (file: string, message: string) => project.diagnostics.push({ file, message });

  for (const song of project.songs) {
    if (song.song && song.song.data.name !== song.name) {
      push(song.song.path, `name "${song.song.data.name}" must match directory "${song.name}"`);
    }

    if (song.tempo) {
      try {
        new TempoMap(song.tempo.data.tempo, project.manifest?.data.sample_rate ?? 48000);
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
        const assetPath = join(project.root, song.dir, clip.asset);
        if (!existsSync(assetPath)) {
          push(track.path, `clip "${clip.id}" asset not found: ${clip.asset}`);
        }
      }
    }

    for (const take of song.takes) {
      if (!trackNames.has(take.data.track)) {
        push(take.path, `take references unknown track "${take.data.track}"`);
      }
      const assetPath = join(project.root, song.dir, take.data.asset);
      if (!existsSync(assetPath)) {
        push(take.path, `asset not found: ${take.data.asset}`);
      }
    }
  }
}

// Files whose formatting differs from canonical (project-core.md §3.6).
export function unformattedFiles(project: LoadedProject): string[] {
  const out: string[] = [];
  const consider = (file: LoadedFile<unknown> | undefined, order: KeyOrder) => {
    if (!file) return;
    if (canonicalText(file.raw, order) !== file.raw) out.push(file.path);
  };
  consider(project.manifest, projectOrder);
  for (const song of project.songs) {
    consider(song.song, songOrder);
    consider(song.tempo, tempoFileOrder);
    consider(song.arrangement, arrangementOrder);
    for (const track of song.tracks) consider(track, trackOrder);
    for (const take of song.takes) consider(take, takeOrder);
  }
  return out;
}

export const fileOrders = {
  project: projectOrder,
  song: songOrder,
  tempo: tempoFileOrder,
  arrangement: arrangementOrder,
  track: trackOrder,
  take: takeOrder,
} as const;
