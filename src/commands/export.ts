import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { sha256File } from '../hash.js';
import { resolvePlayables } from './play.js';
import type { GeneratorRunner } from '../graph/build.js';

// bloom export: build a label and drop the result somewhere a human
// works, under a name a human can read. The build's own outputs live at
// `.bloom/out/<label path>.wav` (and committed sources under their song's
// audio/), which is right for the engine and useless in a Finder window
// or an email — this is the one command whose product is a *file you
// take somewhere else*.
//
// It exports what `play` would play, through the same resolver, so the
// two commands can never disagree about which file a label means. Only
// the labels the patterns match are exported — the dependencies a build
// prints are means, not products.
//
// Exports are versioned, never overwritten: finishing a mix and putting
// it somewhere is how people mark a version, and the previous one is
// often the only copy of a decision that was later undone. So a Desktop
// accumulates creek-mix-main-v1.wav, -v2, -v3, and nothing Bloom does
// removes any of them.

export interface ExportResult {
  label: string;
  from: string; // the artifact the build produced or the source it names
  to: string;
  version: number; // the version `to` names — existing when unchanged
  // Some version already holds these bytes, so `to` names it and nothing
  // was written. Exporting twice without changing anything is a habit,
  // not a request for a duplicate — and a change undone lands back on an
  // older version, which is worth being told about rather than filed as
  // a new one (`version` < `newest` says exactly that happened).
  unchanged: boolean;
  newest: number; // highest version present before this export, 0 if none
}

export interface ExportOptions {
  to?: string | undefined; // destination directory, default ~/Desktop
  runner?: GeneratorRunner | undefined;
}

export function defaultExportDir(): string {
  return join(homedir(), 'Desktop');
}

// Paths under $HOME print with a tilde: an export line is meant to be
// read at a glance, and the interesting half is the end of it. Only a
// path that is $HOME or sits beneath it qualifies — `/Users/justinx`
// must not become `~x`.
export function homeRelative(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// `//songs/creek/mix:main` → `creek-mix-main`: the whole label with the
// punctuation flattened, minus the `songs/` prefix every song carries.
// Shared material keeps its shelf (`//shared/assets:water` →
// `shared-assets-water`), which is what makes the name say where the
// thing came from.
//
// Long on purpose. The short form (`creek-main`) reads better right up
// until a song has a track and a sound of the same name — legal, and the
// natural thing to do when a track plays one sound — and then two
// different files want one name. A name that is sometimes scoped is
// worse than one that always is: you cannot predict the file you are
// about to get.
//
// Every part is a slug by grammar (`[a-z0-9-]`), so the result needs no
// sanitizing and cannot contain a path separator.
export function exportBaseName(label: string): string {
  const [pkg = '', name = ''] = label.replace(/^\/\//, '').split(':');
  const segments = pkg.split('/').filter((s) => s !== '');
  if (segments[0] === 'songs') segments.shift();
  return [...segments, name].join('-');
}

// Every version of one label already sitting in the directory, newest
// first. Versions are `-v<n>` before the extension, so the family is a
// filename question — no state, no manifest, nothing to get out of sync
// with what is actually on the disk.
export function existingVersions(
  dir: string,
  base: string,
  extension: string,
): { version: number; path: string }[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-v(\\d+)${extension.replace(/\./g, '\\.')}$`);
  const found: { version: number; path: string }[] = [];
  for (const file of readdirSync(dir)) {
    const match = pattern.exec(file);
    if (match) found.push({ version: Number(match[1]), path: join(dir, file) });
  }
  return found.sort((a, b) => b.version - a.version);
}

// Numbered from what is already there: max + 1, never reusing a number a
// deleted file had. A gap is history too — v2 missing means someone threw
// v2 away, and minting a second v2 would quietly disagree with them.
export function nextVersion(dir: string, base: string, extension: string): number {
  return (existingVersions(dir, base, extension)[0]?.version ?? 0) + 1;
}

export function versionedName(base: string, version: number, extension: string): string {
  return `${base}-v${version}${extension}`;
}

export async function exportLabels(
  root: string,
  patterns: string[],
  options: ExportOptions = {},
): Promise<ExportResult[]> {
  const dir = options.to ?? defaultExportDir();
  // A missing destination is a typo or a machine without a Desktop, and
  // creating it would bury both: `bloom export --to ~/Desktps` should
  // say so, not silently mint a directory.
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`no such directory: ${dir}`);
  }
  const items = await resolvePlayables(root, patterns, options.runner);

  // Two labels flattening to one name would version each other — v1 and
  // v2 of "the same thing" that are different things. The naming makes
  // this all but unreachable; if it ever happens, say so rather than
  // produce a plausible lie.
  const bases = new Map<string, string>();
  for (const item of items) {
    const base = exportBaseName(item.label);
    const first = bases.get(base);
    if (first !== undefined) {
      throw new Error(`${first} and ${item.label} would both export as ${base} — export them separately`);
    }
    bases.set(base, item.label);
  }

  const results: ExportResult[] = [];
  for (const item of items) {
    const base = exportBaseName(item.label);
    const extension = extname(item.path);
    const versions = existingVersions(dir, base, extension);
    const newest = versions[0]?.version ?? 0;

    // Every version, not just the newest: export v4, change something,
    // export v5, change it back — this is v4 again, and filing it as v6
    // would bury that. Newest first, so the common case (nothing changed
    // since the last export) matches on the first comparison.
    const existing = await findIdentical(versions, item.path, item.sha256);
    if (existing !== undefined) {
      results.push({
        label: item.label,
        from: item.path,
        to: existing.path,
        version: existing.version,
        unchanged: true,
        newest,
      });
      continue;
    }

    const to = join(dir, versionedName(base, newest + 1, extension));
    copyFileSync(item.path, to);
    results.push({
      label: item.label,
      from: item.path,
      to,
      version: newest + 1,
      unchanged: false,
      newest,
    });
  }
  return results;
}

// The version holding these exact bytes, if one does. Size is checked
// first because it is a stat rather than a read: a mix that differs
// audibly usually differs in length, and hashing every old version of a
// long render on every export would be the slowest thing this command
// does. Same size still gets hashed — a fader move keeps the length.
async function findIdentical(
  versions: { version: number; path: string }[],
  artifact: string,
  sha256: string,
): Promise<{ version: number; path: string } | undefined> {
  const bytes = statSync(artifact).size;
  for (const candidate of versions) {
    if (statSync(candidate.path).size !== bytes) continue;
    if ((await sha256File(candidate.path)) === sha256) return candidate;
  }
  return undefined;
}
