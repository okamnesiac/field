import { copyFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
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

export interface ExportResult {
  label: string;
  from: string; // the artifact the build produced or the source it names
  to: string;
  replaced: boolean; // a file of that name was already there
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

// `//songs/creek/mix:main` → `creek-main.wav`: the song and the thing,
// which is how you would say it out loud. Shared material has no song to
// name, so it keeps its own (`//shared/assets:water` → `water.wav`).
// Every part is already a slug — labels are `[a-z0-9-]` by grammar — so
// the result needs no sanitizing and can't collide with a path
// separator. `scoped` adds the package's last segment for labels that
// would otherwise land on the same name (a song's `tracks:pad` and
// `sounds:pad`).
export function exportFileName(label: string, extension: string, scoped = false): string {
  const [pkg = '', name = ''] = label.replace(/^\/\//, '').split(':');
  const segments = pkg.split('/');
  // songs/<song>/<scope> for song material; <scope> alone for shared.
  const song = segments[0] === 'songs' ? segments[1] : undefined;
  const scope = segments[segments.length - 1];
  const parts = [song, scoped ? scope : undefined, name].filter((p) => p !== undefined && p !== '');
  return `${parts.join('-')}${extension}`;
}

// Names for a whole export run, disambiguating only where it is needed:
// one collision must not rename everything else, and a renamed file must
// not be the only one renamed in its collision group.
function exportNames(items: { label: string; path: string }[]): string[] {
  const plain = items.map((i) => exportFileName(i.label, extname(i.path)));
  const counts = new Map<string, number>();
  for (const name of plain) counts.set(name, (counts.get(name) ?? 0) + 1);
  return items.map((item, i) =>
    (counts.get(plain[i]!) ?? 0) > 1 ? exportFileName(item.label, extname(item.path), true) : plain[i]!,
  );
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
  const names = exportNames(items);
  return items.map((item, i) => {
    const to = join(dir, names[i]!);
    const replaced = existsSync(to);
    copyFileSync(item.path, to);
    return { label: item.label, from: item.path, to, replaced };
  });
}
