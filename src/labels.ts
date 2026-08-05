// Build labels (project-core.md §3.4): `//path:name`, absolute-only in V1,
// with wildcards `//path/...` (every target under path) and `//path:all`
// (every target in one package). The project model is the build file —
// packages derive from it by convention:
//   entity file      songs/creek/tracks/drums.yaml  → //songs/creek/tracks:drums
//   collection file  songs/creek/assets.yaml        → //songs/creek/assets:<entry>
//                    songs/creek/targets.yaml       → //songs/creek/targets:<entry>

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
export const RESERVED_TARGET_NAME = 'all';

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

export function parsePattern(text: string): LabelPattern {
  if (!text.startsWith('//')) {
    throw new Error(`labels are absolute: "${text}" must start with //`);
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
    throw new Error(`missing target name in "${text}" (use //pkg:name, //pkg:all, or //pkg/...)`);
  }
  const pkg = rest.slice(0, colon);
  const name = rest.slice(colon + 1);
  if (!PKG_PATTERN.test(pkg)) throw new Error(`invalid package in "${text}"`);
  if (name === 'all') return { kind: 'package-all', pkg };
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid target name in "${text}"`);
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
