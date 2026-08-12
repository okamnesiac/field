// `field insert add` (add-insert.md): write a hosted insert into a
// track's YAML, fully pinned at birth — identity, version, latency
// from the scan, through the same comment-preserving Document
// machinery the pinner uses — with the interactive halves (plugin
// chooser, order chooser, duplicate handles) injected as hooks so the
// core is testable and a script never hangs on a prompt.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { PluginInfo } from '../audio/plugins.js';
import { readInventory } from '../audio/plugins.js';
import { resolvePluginName } from './plugins.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { trackOrder } from '../schema/index.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';
import type { PickerItem } from './picker.js';

export interface AddInsertHooks {
  // Present on a TTY, absent in a script — each absence has a recorded
  // non-interactive answer (add-insert.md §2): no chooser means the
  // plugin must be named, no order chooser means the end, no id prompt
  // means the duplicate case refuses.
  choosePlugin?: (items: PickerItem<PluginInfo>[]) => Promise<PluginInfo | undefined>;
  choosePosition?: (labels: string[], defaultIndex: number) => Promise<number | undefined>;
  askId?: (prompt: string) => Promise<string | undefined>;
}

export interface AddInsertOptions {
  plugin?: string; // display name from the command line
  at?: string; // 1-based chain position, or "end"
  id?: string; // the new instance's handle, scriptable spelling
  prefer?: 'au' | 'vst3';
  hooks?: AddInsertHooks;
}

export interface AddInsertOutcome {
  cancelled?: boolean;
  file?: string; // project-relative track file the write landed in
  song?: string;
  track?: string;
  // The track half of a `field open` address, in the decided grammar
  // (add-insert.md §2): bare while the name is unique project-wide,
  // `<song>/<track>` when it collides — computed here because the
  // handoff must not advertise an ambiguous spelling (Codex on #155).
  address?: string;
  plugin?: PluginInfo;
  position?: number; // 1-based, after the write
  chainLength?: number;
  handle?: string; // id if one was written, else the display name
  backfilled?: string[]; // incumbent ids written alongside (disclosed)
}

// The chooser rows (add-insert.md §3): recently used sorts first —
// recency derived from identities already pinned in the project's own
// files, no new state — search matches name, manufacturer, and format
// tokens, rows that collide on name/format/version grow the
// identifier, and a versionless row carries the pinner's refusal on
// itself rather than after a write.
export function chooserItems(
  inventory: { plugins: PluginInfo[] },
  project: LoadedProject,
): PickerItem<PluginInfo>[] {
  const used = new Set<string>();
  for (const song of project.songs) {
    for (const track of song.tracks) {
      for (const insert of track.data.inserts) {
        if ('plugin' in insert) {
          const identity = insert.au ?? insert.vst3;
          if (identity !== undefined) used.add(identity);
        }
      }
    }
  }
  const collisions = new Map<string, number>();
  for (const p of inventory.plugins) {
    const key = `${p.name}\0${p.format}\0${p.version}`;
    collisions.set(key, (collisions.get(key) ?? 0) + 1);
  }
  const sorted = [...inventory.plugins].sort((a, b) => {
    const aUsed = used.has(a.identifier) ? 0 : 1;
    const bUsed = used.has(b.identifier) ? 0 : 1;
    if (aUsed !== bUsed) return aUsed - bUsed;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return sorted.map((p) => {
    const ambiguous = (collisions.get(`${p.name}\0${p.format}\0${p.version}`) ?? 0) > 1;
    const version = p.version === '' ? '' : ` ${p.version}`;
    const identity = ambiguous ? `  ${p.identifier}` : '';
    return {
      label: `${p.name} — ${p.manufacturer}  ${p.format}${version}${identity}`,
      search: `${p.name} ${p.manufacturer} ${p.format}`.toLowerCase(),
      ...(p.version === '' ? { disabled: 'no version reported — cannot be pinned' } : {}),
      value: p,
    };
  });
}

interface ResolvedTrack {
  song: string;
  trackName: string;
  path: string; // project-relative
}

// Track addressing (add-insert.md §2): a bare name when it is unique
// across the project, `<song>/<track>` to qualify — the refusal for a
// collision names the qualified spellings, so the fix is a copy-paste.
function resolveTrack(project: LoadedProject, ref: string): ResolvedTrack {
  const slash = ref.indexOf('/');
  if (slash >= 0) {
    const songName = ref.slice(0, slash);
    const trackName = ref.slice(slash + 1);
    const song = project.songs.find((s) => s.name === songName);
    if (song === undefined) throw new Error(`no song named "${songName}"`);
    const track = song.tracks.find((t) => t.data.name === trackName);
    if (track === undefined) {
      throw new Error(`song "${songName}" has no track named "${trackName}"`);
    }
    return { song: songName, trackName, path: track.path };
  }
  const matches: ResolvedTrack[] = [];
  for (const song of project.songs) {
    for (const track of song.tracks) {
      if (track.data.name === ref) {
        matches.push({ song: song.name, trackName: ref, path: track.path });
      }
    }
  }
  if (matches.length === 0) throw new Error(`no track named "${ref}" in any song`);
  if (matches.length > 1) {
    throw new Error(
      `"${ref}" is a track in ${matches.length} songs — qualify it: ` +
        matches.map((m) => `${m.song}/${ref}`).join(' or '),
    );
  }
  return matches[0]!;
}

// One insert's display name for the order chooser's position labels.
function insertName(item: unknown): string {
  if (isMap(item)) {
    const plugin = item.get('plugin');
    if (typeof plugin === 'string') return plugin;
    const effect = item.get('effect');
    if (typeof effect === 'string') return effect;
  }
  return '(insert)';
}

export function positionLabels(names: string[]): string[] {
  const labels = names.map((name, i) => `${i + 1} · before ${name}`);
  labels.push(`end · after ${names[names.length - 1] ?? 'nothing'}`);
  return labels;
}

function parseAt(at: string, chainLength: number): number {
  if (at === 'end') return chainLength;
  const n = Number(at);
  if (!Number.isInteger(n) || n < 1 || n > chainLength + 1) {
    throw new Error(
      `--at ${at} is not a position in a chain of ${chainLength} — 1 through ${chainLength + 1}, or end`,
    );
  }
  return n - 1;
}

export async function addInsert(
  root: string,
  trackRef: string,
  options: AddInsertOptions = {},
): Promise<AddInsertOutcome> {
  const project = loadProject(root);
  const target = resolveTrack(project, trackRef);

  const inventory = readInventory(root);
  if (inventory === undefined) {
    throw new Error('no scan yet — field plugins scan');
  }

  // Which plugin: named → decision 2's resolution, shared with the
  // pinner; unnamed → the chooser, whose absence is a refusal with the
  // exact command line to run instead, never a hang.
  let plugin: PluginInfo;
  if (options.plugin !== undefined) {
    const resolved = resolvePluginName(inventory, options.plugin, options.prefer);
    if ('problem' in resolved) throw new Error(resolved.problem);
    plugin = resolved.installed;
  } else {
    if (options.hooks?.choosePlugin === undefined) {
      throw new Error(
        `no plugin named and no TTY to choose one — field insert add ${trackRef} "<plugin>" ` +
          `names it (field plugins list shows the inventory)`,
      );
    }
    const chosen = await options.hooks.choosePlugin(chooserItems(inventory, project));
    if (chosen === undefined) return { cancelled: true };
    plugin = chosen;
  }
  // The pinner's refusal, before a write rather than after: a plugin
  // that reports no version cannot be pinned, and this command never
  // writes an unpinned insert.
  if (plugin.version === '') {
    throw new Error(
      `"${plugin.name}" reports no version; it cannot be pinned (${plugin.format} ${plugin.identifier})`,
    );
  }

  const absolute = join(project.root, target.path);
  const doc = parseDocument(readFileSync(absolute, 'utf8'));
  const existing = doc.getIn(['inserts']);
  const chain = isSeq(existing) ? existing.items : [];
  const names = chain.map(insertName);

  // Where in the chain: the flag places without asking, the chooser
  // asks when there is a choice, and a script with the plugin named
  // takes the chooser's own default — the end — silently (§2/§4).
  let index: number;
  if (options.at !== undefined) {
    index = parseAt(options.at, chain.length);
  } else if (chain.length === 0) {
    index = 0;
  } else if (options.hooks?.choosePosition !== undefined) {
    const labels = positionLabels(names);
    const picked = await options.hooks.choosePosition(labels, labels.length - 1);
    if (picked === undefined) return { cancelled: true };
    index = picked;
  } else {
    index = chain.length;
  }

  // Duplicate identities need handles on *every* instance — the check
  // quantifies over the identity group (model/project.ts), so the
  // incumbents are prompted too, and that extra write is disclosed in
  // the outcome rather than slipped into the diff (add-insert.md §2).
  const identityOf = (item: unknown): string | undefined => {
    if (!isMap(item)) return undefined;
    const au = item.get('au');
    const vst3 = item.get('vst3');
    const name = item.get('plugin');
    if (typeof au === 'string') return au;
    if (typeof vst3 === 'string') return vst3;
    return typeof name === 'string' ? `name:${name}` : undefined;
  };
  const incumbentIds = new Set<string>();
  for (const item of chain) {
    if (isMap(item) && typeof item.get('id') === 'string') {
      incumbentIds.add(item.get('id') as string);
    }
  }
  // Both spellings of "the same plugin": the identity when the
  // incumbent is pinned, the name when it is not — an unpinned
  // hand-authored instance is the §1 flow this command shortcuts, and
  // pinBeforeCheck collapses the two into one identity group before
  // the duplicate rule runs, so missing it here writes exactly the
  // file §2 promises not to (minjudd on #155).
  const sameIdentity = chain.filter((item) => {
    const identity = identityOf(item);
    return identity === plugin.identifier || identity === `name:${plugin.name}`;
  });
  let newId = options.id;
  const backfilled: string[] = [];
  if (sameIdentity.length > 0) {
    const needIncumbentIds = sameIdentity.filter(
      (item) => !(isMap(item) && typeof item.get('id') === 'string'),
    );
    if (newId === undefined || needIncumbentIds.length > 0) {
      if (options.hooks?.askId === undefined) {
        throw new Error(
          `"${plugin.name}" is already in this chain, so every instance needs an id ` +
            `(plugin-hosting.md decision 6) — run interactively, or pass --id for the new ` +
            `insert once the existing ones carry ids`,
        );
      }
      for (const item of needIncumbentIds) {
        const at = chain.indexOf(item) + 1;
        const given = await options.hooks.askId(
          `the existing "${plugin.name}" at position ${at} needs an id`,
        );
        if (given === undefined || given === '') return { cancelled: true };
        if (incumbentIds.has(given)) throw new Error(`duplicate insert id "${given}"`);
        incumbentIds.add(given);
        (item as import('yaml').YAMLMap).set('id', given);
        backfilled.push(given);
      }
      if (newId === undefined) {
        const given = await options.hooks.askId(`an id for the new "${plugin.name}"`);
        if (given === undefined || given === '') return { cancelled: true };
        newId = given;
      }
    }
    if (incumbentIds.has(newId)) throw new Error(`duplicate insert id "${newId}"`);
  }

  const insert: Record<string, unknown> = {
    plugin: plugin.name,
    ...(newId !== undefined ? { id: newId } : {}),
    [plugin.format]: plugin.identifier,
    version: plugin.version,
    ...(plugin.latency > 0 ? { latency: plugin.latency } : {}),
  };
  if (isSeq(existing)) {
    existing.items.splice(index, 0, doc.createNode(insert));
  } else {
    doc.set('inserts', doc.createNode([insert]));
  }
  canonicalizeDocument(doc, trackOrder);
  writeFileSync(absolute, stringifyDocument(doc));

  const collides =
    project.songs.filter((s) => s.tracks.some((t) => t.data.name === target.trackName)).length > 1;
  return {
    file: target.path,
    song: target.song,
    track: target.trackName,
    address: collides ? `${target.song}/${target.trackName}` : target.trackName,
    plugin,
    position: index + 1,
    chainLength: chain.length + 1,
    handle: newId ?? plugin.name,
    backfilled,
  };
}
