// Hosted-plugin plumbing (plugin-hosting.md chunk 1): the scan
// inventory, the state-blob pool, and the transport segments both render
// paths supply (decision 13).
//
// The inventory (.field/plugins.json) is machine-local by design — it
// records what is installed here, which is exactly the thing the
// repository must never depend on. Everything the action key sees comes
// from the YAML or the blob pool; the inventory only ever supplies
// machine-local hints (paths) and validation the plan defers to machines
// that have the plugin.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { BUILD_DAEMON, daemonBinary } from '../audiod/client.js';
import { PPQ } from '../constants.js';
import { sha256FileSync } from '../hash.js';
import type { PluginInsert } from '../schema/effects.js';
import type { MeterEvent, TempoEvent } from '../time/tempo.js';
import { TempoMap } from '../time/tempo.js';

export const pluginInfoSchema = z.object({
  format: z.enum(['au', 'vst3']),
  name: z.string(),
  identifier: z.string(),
  version: z.string(),
  manufacturer: z.string(),
  path: z.string(),
  latency: z.number().int(),
  params: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      label: z.string(),
      // Optional so an inventory scanned before these fields existed
      // still reads; validation defers where they are absent, the same
      // rule as having no scan at all.
      discrete: z.boolean().optional(),
      steps: z.number().int().optional(),
      labels: z.array(z.string()).optional(),
    }),
  ),
});
export type PluginInfo = z.infer<typeof pluginInfoSchema>;

export interface PluginInventory {
  plugins: PluginInfo[];
  failed: string[]; // candidates whose probe crashed — recorded, never silent
}

const INVENTORY_RELATIVE = join('.field', 'plugins.json');

// The parsed inventory, cached by file identity. A real scan runs to
// tens of megabytes — a 482-plugin machine's is 75 MB, almost all of
// it param tables — and one compile reads it twice (loadProject's
// pin-drift validation, toPluginWire's path hint), which made the
// parse most of a second of every live-watch swap: ~230 ms per read
// plus the GC it drags in, measured against a ~1.35 s compile. The
// watch loop is one long-lived process, so caching here turns that
// into a stat per read. Keyed by path, invalidated on mtime or size —
// a fresh scan lands the moment plugins.json changes — and sharing
// the parsed object is safe because every caller treats the
// inventory as read-only (writers go through the file). ctime and
// inode ride along because mtime and size alone miss a same-length
// replacement that preserves timestamps (cp -p, a restored backup):
// ctime is stamped by the filesystem on any write and cannot be set
// from userland, and the inode changes on a rename-replace (Codex on
// this PR).
const inventoryCache = new Map<
  string,
  { mtimeNs: bigint; ctimeNs: bigint; ino: bigint; size: bigint; inventory: PluginInventory }
>();

export function readInventory(root: string): PluginInventory | undefined {
  const path = join(root, INVENTORY_RELATIVE);
  if (!existsSync(path)) return undefined;
  const stat = statSync(path, { bigint: true });
  const cached = inventoryCache.get(path);
  if (
    cached !== undefined &&
    cached.mtimeNs === stat.mtimeNs &&
    cached.ctimeNs === stat.ctimeNs &&
    cached.ino === stat.ino &&
    cached.size === stat.size
  ) {
    return cached.inventory;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const inventory = z
    .object({ plugins: z.array(pluginInfoSchema), failed: z.array(z.string()) })
    .parse(parsed);
  inventoryCache.set(path, {
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    ino: stat.ino,
    size: stat.size,
    inventory,
  });
  return inventory;
}

// Run the daemon's scanner: one --scan per format, each candidate probed
// in its own subprocess so a crashy plugin is a recorded skip.
export function scanPlugins(root: string): PluginInventory {
  const binary = daemonBinary();
  if (binary === undefined) {
    throw new Error(`field-audiod is not built — run ${BUILD_DAEMON}; the daemon owns scanning`);
  }
  const formats = process.platform === 'darwin' ? ['au', 'vst3'] : ['vst3'];
  const plugins: PluginInfo[] = [];
  const failed: string[] = [];
  for (const format of formats) {
    const result = spawnSync(binary, ['--scan', format], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`field-audiod --scan ${format} failed: ${result.stderr.trim()}`);
    }
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const parsed: unknown = JSON.parse(line);
      const failure = z.object({ failed: z.string() }).safeParse(parsed);
      if (failure.success) {
        failed.push(failure.data.failed);
        continue;
      }
      plugins.push(pluginInfoSchema.parse(parsed));
    }
  }
  mkdirSync(join(root, '.field'), { recursive: true });
  writeFileSync(
    join(root, INVENTORY_RELATIVE),
    `${JSON.stringify({ plugins, failed }, null, 2)}\n`,
  );
  return { plugins, failed };
}

export function findInstalled(
  inventory: PluginInventory | undefined,
  format: 'au' | 'vst3',
  identifier: string,
): PluginInfo | undefined {
  return inventory?.plugins.find((p) => p.format === format && p.identifier === identifier);
}

// The write-time directory convention (decision 4): lowercase, spaces to
// hyphens, anything else dropped. Reads never depend on it.
export function pluginSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replaceAll(/\s+/g, '-')
      .replaceAll(/[^a-z0-9-]/g, '')
      .replaceAll(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'plugin'
  );
}

// The state-blob pool: every *.state file under shared/plugins/, named
// by its full content hash. Location is cosmetic; the filename is the
// identity, so the index is a directory listing and the drift guard
// (content hashes to its own filename) runs where blobs are consumed
// (verifyAssetHashes).
export interface StateBlob {
  sha256: string;
  path: string; // project-relative
}

export function indexStateBlobs(root: string): StateBlob[] {
  const base = join(root, 'shared', 'plugins');
  if (!existsSync(base)) return [];
  const blobs: StateBlob[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.isFile() && entry.name.endsWith('.state')) {
        const stem = entry.name.slice(0, -'.state'.length);
        if (/^[0-9a-f]{64}$/.test(stem)) {
          blobs.push({ sha256: stem, path: `shared/plugins/${rel}` });
        }
      }
    }
  };
  walk(base, '');
  return blobs.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
}

// Prefix resolution: unique or refused, never guessed (decision 4).
export function resolveStateRef(
  ref: string,
  blobs: StateBlob[],
): { blob?: StateBlob; problem?: string } {
  const matches = blobs.filter((b) => b.sha256.startsWith(ref));
  if (matches.length === 1) return { blob: matches[0]! };
  if (matches.length === 0) {
    return { problem: `no state blob matching "${ref}" under shared/plugins/` };
  }
  return {
    problem:
      `state ref "${ref}" is ambiguous — it matches ` +
      matches.map((m) => m.path).join(' and '),
  };
}

// The keyed spelling of a hosted insert (decision 8): identity, version,
// latency, declared tail, the *full* state hash, the authored params
// canonicalized by name, and the track's resolved transport. The display
// name is never here (cosmetic), and machine-local paths are never here
// — those join only the wire form execute() sends the daemon.
export interface PluginInsertSpec {
  effect: 'plugin';
  format: 'au' | 'vst3';
  identifier: string;
  version: string;
  latency: number;
  tail?: number;
  state_sha256?: string;
  params: { name: string; value: number | string }[];
  transport: { segments: TransportSegment[] };
}

export interface PluginWireInsert extends PluginInsertSpec {
  name: string; // display, for daemon errors
  path?: string; // machine-local hint; the identifier decides
  state_path?: string; // absolute path of the resolved blob
}

export interface HostedTrackContext {
  transport: TransportSegment[];
  stateBlobs: StateBlob[];
}

// YAML arm → keyed spec. Throwing here is the build-time refusal — check
// says the same things as diagnostics first, so reaching these messages
// means building past a red check.
export function toPluginSpec(
  insert: PluginInsert,
  trackName: string,
  hosted: HostedTrackContext,
): PluginInsertSpec {
  const format = insert.au !== undefined ? 'au' : insert.vst3 !== undefined ? 'vst3' : undefined;
  const identifier = insert.au ?? insert.vst3;
  if (format === undefined || identifier === undefined || insert.version === undefined) {
    throw new Error(
      `"${insert.plugin}" on track "${trackName}" is not pinned — field plugins scan, ` +
        `then field check writes the identity and version lines back ` +
        `(plugin-hosting.md decision 2)`,
    );
  }
  let stateSha256: string | undefined;
  if (insert.state !== undefined) {
    const { blob, problem } = resolveStateRef(insert.state, hosted.stateBlobs);
    if (problem !== undefined) throw new Error(`track "${trackName}": ${problem}`);
    stateSha256 = blob!.sha256;
  }
  return {
    effect: 'plugin',
    format,
    identifier,
    version: insert.version,
    latency: insert.latency ?? 0,
    ...(insert.tail !== undefined ? { tail: insert.tail } : {}),
    ...(stateSha256 !== undefined ? { state_sha256: stateSha256 } : {}),
    params: Object.entries(insert.params ?? {})
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => ({ name, value })),
    transport: { segments: hosted.transport },
  };
}

// Spec → wire: the machine-local half, resolved at execute time on the
// machine that renders. A missing blob is an error (the key promised
// those bytes); a missing inventory entry only costs the path hint — the
// daemon falls back to a full search and its own not-installed message.
export function toPluginWire(spec: PluginInsertSpec, root: string): PluginWireInsert {
  const inventory = readInventory(root);
  const installed = findInstalled(inventory, spec.format, spec.identifier);
  let statePath: string | undefined;
  if (spec.state_sha256 !== undefined) {
    const blob = indexStateBlobs(root).find((b) => b.sha256 === spec.state_sha256);
    if (blob === undefined) {
      throw new Error(
        `state blob ${spec.state_sha256} is referenced but not in shared/plugins/ — ` +
          `the action key promised those bytes`,
      );
    }
    statePath = join(root, blob.path);
    // The drift guard runs here too, not only in check: `field build`
    // never calls verifyAssetHashes, and a cold render must not cache
    // drifted bytes under a key naming the filename's hash (Codex).
    const actual = sha256FileSync(statePath);
    if (actual !== spec.state_sha256) {
      throw new Error(
        `state blob ${blob.path} content does not hash to its filename (hashes to ${actual}) — ` +
          `field check names it`,
      );
    }
  }
  return {
    ...spec,
    name: installed?.name ?? spec.identifier,
    ...(installed !== undefined ? { path: installed.path } : {}),
    ...(statePath !== undefined ? { state_path: statePath } : {}),
  };
}

// The track-local transport (decision 13): piecewise-constant tempo
// segments on the track's own sample clock. Ramped tempo spans are
// subdivided per quarter so the playhead's linear ppq stays within a
// quarter's drift of the ramp's integral — the same resolved map is an
// action-key input, so both render paths and the cache all see one
// spelling.
export interface TransportSegment {
  sample: number;
  ppq: number;
  bpm: number;
  numerator: number;
  denominator: number;
}

export function transportSegments(
  tempoEvents: readonly TempoEvent[],
  meterEvents: readonly MeterEvent[],
  tempoMap: TempoMap,
): TransportSegment[] {
  const boundaryTicks = new Set<number>();
  for (const event of tempoEvents) {
    boundaryTicks.add(event.at);
    if (event.ramp === 'linear') {
      const next = tempoEvents.find((candidate) => candidate.at > event.at);
      if (next !== undefined) {
        for (let tick = event.at + PPQ; tick < next.at; tick += PPQ) boundaryTicks.add(tick);
      }
    }
  }
  for (const event of meterEvents) boundaryTicks.add(event.at);

  const meterAt = (tick: number): MeterEvent => {
    let active = meterEvents[0]!;
    for (const event of meterEvents) {
      if (event.at <= tick) active = event;
      else break;
    }
    return active;
  };
  const bpmAt = (tick: number): number => {
    let index = 0;
    for (let i = 0; i < tempoEvents.length; i++) {
      if (tempoEvents[i]!.at <= tick) index = i;
      else break;
    }
    const event = tempoEvents[index]!;
    const next = tempoEvents[index + 1];
    if (event.ramp !== 'linear' || next === undefined) return event.bpm;
    const span = next.at - event.at;
    return event.bpm + ((next.bpm - event.bpm) * (tick - event.at)) / span;
  };

  return [...boundaryTicks]
    .sort((a, b) => a - b)
    .map((tick) => {
      const meter = meterAt(tick);
      return {
        sample: tempoMap.ticksToSamples(tick),
        ppq: tick / PPQ,
        bpm: bpmAt(tick),
        numerator: meter.numerator,
        denominator: meter.denominator,
      };
    });
}
