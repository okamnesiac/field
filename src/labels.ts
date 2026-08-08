// Build labels (project-core.md §3.4): `//path:name`, with wildcards
// `//path/...` (everything under path) and `//path:all` (everything in
// one package). The project model is the build file — packages derive
// from it by convention, and a package is the *singular* of the
// directory that holds it, because a label addresses one thing:
// `//songs/creek/track:keys` reads "the keys track" (project-layout.md
// §4.5, amended).
//   entity file      songs/creek/tracks/drums.yaml   → //songs/creek/track:drums
//                    songs/creek/sounds/kit-sc.yaml  → //songs/creek/sound:kit-sc
//   collection file  songs/creek/assets.yaml         → //songs/creek/asset:<entry>
//                    shared/assets.yaml              → //shared/asset:<entry>
// The directories and the ledger's `assets:` key stay plural: a folder
// and a list hold many, which is the distinction the singular package
// draws attention to.
// Canonical form is absolute; the CLI additionally accepts songs-relative
// shorthand (`creek/mix:main` = `//songs/creek/mix:main`) because nearly
// everything addressable lives under songs/, and a bare song name
// (`creek`) means its main mix — `main` is a convention, not a
// requirement, so a song that names its mixes otherwise gets a clean
// no-such-label error. Other roots (`//shared/...`) keep the full form.

export interface Label {
  pkg: string; // slash-separated path, no leading or trailing slash
  name: string;
}

export type LabelPattern =
  | { kind: 'label'; label: Label }
  | { kind: 'package-all'; pkg: string } // //pkg:all
  | { kind: 'tree'; pkg: string }; // //pkg/...

const PKG_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// Names the grammar claims for itself: `:all` is package expansion, so no
// addressable thing may be named `all`.
export const RESERVED_LABEL_NAME = 'all';

// The shared ledger's package (project-layout.md §1.6): shared/assets.yaml
// pins reusable committed audio, labeled //shared/asset:<name>.
export const SHARED_ASSETS_PKG = 'shared/asset';

// The one cross-scope reference a clip may make (project-layout.md §1.5):
// a bare name resolves in the song's own ledger, the full
// //shared/asset:<name> label crosses into the shared scope. Returns the
// shared asset's name, or undefined for a bare (song-scoped) ref.
export function sharedAssetName(ref: string): string | undefined {
  const prefix = `//${SHARED_ASSETS_PKG}:`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

export function formatLabel(label: Label): string {
  return `//${label.pkg}:${label.name}`;
}

export function parseLabel(text: string): Label {
  const pattern = parsePattern(text);
  if (pattern.kind !== 'label') {
    throw new Error(`expected a single label, got pattern "${text}"`);
  }
  return pattern.label;
}

// The name a song's output goes by. A convention rather than a type
// (nested-tracks.md §1.2: role lives in the name), and the one place it is
// spelled: a bare song name resolves through it, and it is how a track
// claims the song's declared length.
//
// The kind is the track's. `creek` means `//songs/creek/track:main` — one
// spelling, no fallback to the mix, which is why this and bloom's
// migration are one flag day rather than two halves that each work alone.
export const SONG_OUTPUT_NAME = 'main';

export function parsePattern(text: string): LabelPattern {
  if (!text.startsWith('//')) {
    if (text.startsWith('/')) {
      throw new Error(`invalid label "${text}": use //pkg:name, or songs-relative pkg:name`);
    }
    // A bare song name is its output track, the thing you almost always want.
    if (!text.includes('/') && !text.includes(':') && text !== '...') {
      text = `${text}/track:${SONG_OUTPUT_NAME}`;
    }
    // Uniformly: no special cases, so a song named "songs" stays
    // addressable like any other. The absolute form is the escape hatch.
    text = `//songs/${text}`;
  }
  const rest = text.slice(2);

  if (rest === '...') return { kind: 'tree', pkg: '' }; // //... = everything
  if (rest.endsWith('/...')) {
    const pkg = rest.slice(0, -4);
    if (!PKG_PATTERN.test(pkg)) throw new Error(`invalid package in "${text}"`);
    return { kind: 'tree', pkg };
  }

  const colon = rest.indexOf(':');
  if (colon === -1) {
    throw new Error(`missing label name in "${text}" (use //pkg:name, //pkg:all, or //pkg/...)`);
  }
  const pkg = rest.slice(0, colon);
  const name = rest.slice(colon + 1);
  if (!PKG_PATTERN.test(pkg)) throw new Error(`invalid package in "${text}"`);
  if (name === 'all') return { kind: 'package-all', pkg };
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid label name in "${text}"`);
  return { kind: 'label', label: { pkg, name } };
}

export function matchesPattern(label: Label, pattern: LabelPattern): boolean {
  switch (pattern.kind) {
    case 'label':
      return label.pkg === pattern.label.pkg && label.name === pattern.label.name;
    case 'package-all':
      return label.pkg === pattern.pkg;
    case 'tree':
      return pattern.pkg === '' || label.pkg === pattern.pkg || label.pkg.startsWith(pattern.pkg + '/');
  }
}
