import { copyFileSync, existsSync, linkSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, sep } from 'node:path';
import { hasWavSignature, readWavHeader } from '../audio/wav.js';
import { renderInsertChain } from '../audio/render-daemon.js';
import { sha256File } from '../hash.js';
import { resolvePlayables, type Playable } from './play.js';
import type { GeneratorRunner } from '../graph/build.js';
import type { RemoteReads } from '../remote/cache.js';

// field export: build a label and drop the result somewhere a human
// works, under a name a human can read. The build's own outputs live at
// `.field/out/<label path>.wav` (and committed sources under their song's
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
// accumulates creek-mix-main-v1.wav, -v2, -v3, and nothing Field does
// removes any of them.

export interface ExportResult {
  label: string;
  // The artifact the build produced or the source it names — always a
  // path that outlives the call: when delivery formatting ran, the
  // converted bytes are at `to`, and the conversion's scratch input is
  // gone by the time this returns.
  from: string;
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
  // Delivery formatting (multi-rate.md decision 1): rate and bit depth
  // are export parameters, converted on the way out by the daemon's
  // normalize op — never a node in the song. Either may be given alone;
  // the other defaults to the source's own value where it has one — a
  // float source (everything Field renders) has no integer depth of its
  // own, so it must choose. Conversion always writes integer PCM at the
  // chosen depth, exactly as a `normalize` sound did, which is what
  // lets `loop-cd` retire into an invocation.
  rate?: number | undefined;
  bitDepth?: 16 | 24 | 32 | undefined;
  runner?: GeneratorRunner | undefined;
  remote?: RemoteReads | undefined; // the read-through cache, when the project has one
}

export function defaultExportDir(): string {
  return join(homedir(), 'Desktop');
}

// Paths under $HOME print with a tilde: an export line is meant to be
// read at a glance, and the interesting half is the end of it. Only a
// path that is $HOME or sits beneath it qualifies — `/Users/justinx`
// must not become `~x`. The separator is the platform's, so a Windows
// path under the profile prints as `~\Desktop\…` (windows-portability.md
// §7.2), and Windows paths compare without regard to case.
export function homeRelative(path: string, home = homedir(), separator = sep): string {
  const prefix = path.slice(0, home.length);
  const rest = path.slice(home.length);
  const isHome = separator === '\\' ? prefix.toLowerCase() === home.toLowerCase() : prefix === home;
  return isHome && (rest === '' || rest.startsWith(separator)) ? `~${rest}` : path;
}

// `//songs/creek/mix:main` → `creek-mix-main`: the whole label with the
// punctuation flattened, minus the `songs/` prefix every song carries.
// Shared material keeps its shelf (`//shared/asset:water` →
// `shared-asset-water`), which is what makes the name say where the
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
//
// Matched case-insensitively, because the destination usually is: on
// APFS, `Creek-Mix-Main-v1.wav` and `creek-mix-main-v1.wav` are one
// file, so a case-sensitive scan would miss v1 and then write *through*
// their name into their bytes (#39 review P1). On a case-sensitive
// volume the two really are different files, and skipping the number
// only leaves a gap.
export function existingVersions(
  dir: string,
  base: string,
  extension: string,
): { version: number; path: string }[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-v(\\d+)${extension.replace(/\./g, '\\.')}$`, 'i');
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

// Guard against writing a version number a scan somehow missed. Bounded
// only so a pathological directory cannot spin forever.
const MAX_VERSION_PROBES = 1000;

// Writes `from` into the directory as the first free version at or after
// `startVersion`, and returns the version it took. Two properties matter
// more than the copy itself:
//
// Nothing is ever overwritten. `copyFileSync` onto an existing path
// truncates it, and on a case-insensitive volume "existing" includes a
// name that merely differs in case — so someone's hand bounce called
// `Creek-Mix-Main-v1.wav` would silently become our bytes under their
// filename, which a directory listing does not even show. `link` refuses
// with EEXIST instead, and we take the next number.
//
// A version is complete or absent. The copy lands on a temp name in the
// same directory and is linked into place, so an interrupt leaves debris
// rather than a truncated `-v3.wav` — and since nothing overwrites,
// a truncated version would be permanent and would poison every later
// comparison against the family (#39 review).
export function writeVersion(
  from: string,
  dir: string,
  base: string,
  startVersion: number,
  extension: string,
): { version: number; path: string } {
  const temp = join(dir, `.${base}-v${startVersion}${extension}.part-${process.pid}`);
  copyFileSync(from, temp);
  try {
    for (let version = startVersion; version < startVersion + MAX_VERSION_PROBES; version++) {
      const path = join(dir, versionedName(base, version, extension));
      try {
        linkSync(temp, path);
        return { version, path };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`no free version for ${base} in ${dir} after ${MAX_VERSION_PROBES} tries`);
  } finally {
    unlinkSync(temp);
  }
}

export async function exportLabels(
  root: string,
  patterns: string[],
  options: ExportOptions = {},
): Promise<ExportResult[]> {
  const dir = options.to ?? defaultExportDir();
  // A missing destination is a typo or a machine without a Desktop, and
  // creating it would bury both: `field export --to ~/Desktps` should
  // say so, not silently mint a directory.
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`no such directory: ${dir}`);
  }
  const items = await resolvePlayables(root, patterns, options.runner, options.remote);
  const convert = options.rate !== undefined || options.bitDepth !== undefined;
  // Converted bytes are staged out of sight and versioned from there —
  // the destination only ever sees finished files, same as writeVersion's
  // own temp-and-link discipline.
  const scratch = convert ? mkdtempSync(join(tmpdir(), 'field-export-')) : undefined;
  try {
    // Everything that can refuse the run happens before anything is
    // written to the destination. Every check below rejects the
    // *request*, not one item of it, and a run that half-happened before
    // saying no is the worst outcome: a file appears on the Desktop with
    // only an error on screen, so the one thing you can see disagrees
    // with the one thing you were told (#39 review P3).
    const bases = new Map<string, string>();
    const verified: { item: Playable; path: string; base: string; sha256: string }[] = [];
    for (const [index, item] of items.entries()) {
      // Hash what we are about to copy, rather than trusting what the
      // build recorded. For a committed source that record is the
      // *declared* hash, which the build deliberately does not verify
      // unless it consumes the file as an input — so a bounce written over
      // an asset without re-importing would otherwise export as `current`
      // while the exported file is different audio (#39 review P2).
      // Verified on the original bytes: conversion must not launder drift.
      const originalSha = await sha256File(item.path);
      if (item.committed && originalSha !== item.sha256) {
        throw new Error(
          `refusing to export: ${item.label} content does not match its declared sha256 ` +
            `(field check, then re-import or restore the file)`,
        );
      }

      // Delivery formatting (multi-rate.md decision 1): the daemon's
      // normalize op, on the way out. A flag left off defaults to the
      // source's own value, and the effective pair joins the export name
      // so a converted family never versions an unconverted one — v1 at
      // 48 k and v2 at 44.1 k of "the same thing" would be different
      // things.
      let path = item.path;
      let base = exportBaseName(item.label);
      let sha256 = originalSha;
      if (convert) {
        // Content decides convertibility, the same probe import uses: a
        // WAV the ledger accepted as `.wave` (or bare) is as deliverable
        // as one spelled `.wav`.
        if (extname(item.path).toLowerCase() !== '.wav' && !hasWavSignature(item.path)) {
          throw new Error(
            `cannot convert ${item.label}: ${extname(item.path) || 'no extension'} is not a WAV`,
          );
        }
        const source = readWavHeader(item.path);
        const rate = options.rate ?? source.sampleRate;
        let depth = options.bitDepth;
        if (depth === undefined) {
          // "The source's own value" — which a float source does not
          // have: conversion writes integer PCM, and int32 is not
          // float32's own value, it is the same width in a different
          // encoding. Everything Field renders is float32, so `--rate`
          // alone on a stem must choose rather than surprise (#108
          // review).
          if (source.format === 3) {
            throw new Error(
              `${item.label} is ${source.bitsPerSample}-bit float — conversion ` +
                `writes integer PCM, so pass --bit-depth 16, 24, or 32`,
            );
          }
          const own = source.bitsPerSample;
          if (own !== 16 && own !== 24 && own !== 32) {
            throw new Error(`${item.label} is ${own}-bit — pass --bit-depth 16, 24, or 32`);
          }
          depth = own;
        }
        path = join(scratch!, `${index}.wav`);
        await renderInsertChain({
          op: 'normalize',
          input: item.path,
          output: path,
          sample_rate: rate,
          bit_depth: depth,
        });
        // The dot cannot appear in a label (every part is a slug), so a
        // converted family can never collide with a label that happens
        // to end in digits — `asset:pad-44100-16` exported plain and
        // `asset:pad` at 44100/16 are different names by construction.
        base = `${base}.${rate}-${depth}`;
        sha256 = await sha256File(path);
      }

      // Two labels flattening to one name would version each other — v1
      // and v2 of "the same thing" that are different things. The naming
      // makes this all but unreachable; if it ever happens, say so rather
      // than produce a plausible lie.
      const first = bases.get(base);
      if (first !== undefined) {
        throw new Error(
          `${first} and ${item.label} would both export as ${base} — export them separately`,
        );
      }
      bases.set(base, item.label);
      verified.push({ item, path, base, sha256 });
    }

    const results: ExportResult[] = [];
    for (const { item, path, base, sha256 } of verified) {
      const extension = extname(path);
      const versions = existingVersions(dir, base, extension);
      const newest = versions[0]?.version ?? 0;

      // Every version, not just the newest: export v4, change something,
      // export v5, change it back — this is v4 again, and filing it as v6
      // would bury that. Newest first, so the common case (nothing changed
      // since the last export) matches on the first comparison.
      const existing = await findIdentical(versions, path, sha256);
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

      const written = writeVersion(path, dir, base, newest + 1, extension);
      results.push({
        label: item.label,
        from: item.path,
        to: written.path,
        version: written.version,
        unchanged: false,
        newest,
      });
    }
    return results;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
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
