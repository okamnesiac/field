// field plugins — the hosting inventory verbs (plugin-hosting.md
// chunk 1): `scan` asks the daemon what is installed, `list` prints it,
// and `pin` writes identities back into track files — the
// you-write-the-name, the-tool-writes-the-id split of decision 2.
// `field check` calls the same pin routine when a scan exists, so the
// first check after authoring `- plugin: <name>` is what pins it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isMap, isSeq } from 'yaml';

import {
  findInstalled,
  readInventory,
  scanPlugins,
  type PluginInfo,
  type PluginInventory,
} from '../audio/plugins.js';
import { loadProject, type LoadedProject } from '../model/project.js';
import { trackOrder } from '../schema/index.js';
import { canonicalizeDocument, stringifyDocument } from '../yaml/emit.js';

export function scanCommand(root: string): void {
  const inventory = scanPlugins(root);
  for (const plugin of inventory.plugins) {
    console.log(formatPlugin(plugin));
  }
  for (const failed of inventory.failed) {
    console.log(`failed to probe ${failed} — skipped`);
  }
  const counts = `${inventory.plugins.length} plugin${inventory.plugins.length === 1 ? '' : 's'}`;
  console.log(`scanned: ${counts}, ${inventory.failed.length} failed`);
}

export function listCommand(root: string): void {
  const inventory = readInventory(root);
  if (inventory === undefined) {
    console.log('no scan yet — field plugins scan');
    return;
  }
  for (const plugin of inventory.plugins) {
    console.log(formatPlugin(plugin));
  }
}

function formatPlugin(plugin: PluginInfo): string {
  return `${plugin.name} — ${plugin.format} ${plugin.identifier} ${plugin.version} (${plugin.manufacturer})`;
}

export interface PinEdit {
  file: string; // project-relative track file
  plugin: string;
  format: 'au' | 'vst3';
  identifier: string;
  version: string;
}

export interface PinOutcome {
  edits: PinEdit[];
  problems: { file: string; message: string }[];
}

// Fill the identity, version and latency lines of every unpinned (or
// half-pinned) hosted insert the inventory can resolve. Idempotent: a
// fully pinned entry is untouched unless `update` asks for the installed
// version to replace the pinned one (decision 9's deliberate diff).
export function pinProject(
  project: LoadedProject,
  inventory: PluginInventory,
  options: { prefer?: 'au' | 'vst3'; update?: boolean } = {},
): PinOutcome {
  const edits: PinEdit[] = [];
  const problems: { file: string; message: string }[] = [];

  for (const song of project.songs) {
    for (const track of song.tracks) {
      if (!track.data.inserts.some((insert) => 'plugin' in insert)) continue;

      const path = join(project.root, track.path);
      const doc = parseDocument(readFileSync(path, 'utf8'));
      const inserts = doc.getIn(['inserts']);
      if (!isSeq(inserts)) continue;
      let changed = false;

      for (const item of inserts.items) {
        if (!isMap(item)) continue;
        const name = item.get('plugin');
        if (typeof name !== 'string') continue;
        let touched = false;
        const pinnedAu = item.get('au');
        const pinnedVst3 = item.get('vst3');

        let installed: PluginInfo | undefined;
        if (typeof pinnedAu === 'string') {
          installed = findInstalled(inventory, 'au', pinnedAu);
        } else if (typeof pinnedVst3 === 'string') {
          installed = findInstalled(inventory, 'vst3', pinnedVst3);
        } else {
          // Name-only: resolve, preferring AU on macOS and VST3
          // elsewhere when a product is installed as both (decision 2) —
          // the written pin is the disclosure of which format won.
          const named = inventory.plugins.filter((p) => p.name === name);
          const prefer =
            options.prefer ?? (process.platform === 'darwin' ? 'au' : 'vst3');
          const preferred = named.filter((p) => p.format === prefer);
          const pool = preferred.length > 0 ? preferred : named;
          if (pool.length === 0) {
            problems.push({
              file: track.path,
              message: `no scanned plugin is named "${name}" — field plugins scan after installing it`,
            });
            continue;
          }
          if (pool.length > 1) {
            problems.push({
              file: track.path,
              message:
                `"${name}" matches ${pool.length} scanned plugins — ` +
                pool.map((p) => `${p.format} ${p.identifier}`).join(' and '),
            });
            continue;
          }
          installed = pool[0]!;
          item.set(installed.format, installed.identifier);
          touched = true;
        }

        if (installed === undefined) continue;
        const pinnedVersion = item.get('version');
        if (typeof pinnedVersion !== 'string') {
          item.set('version', installed.version);
          touched = true;
        } else if (pinnedVersion !== installed.version && options.update === true) {
          // A drifted pin without --update stays put — decision 9's
          // refusal, reported by check as a warning and changed only
          // deliberately.
          item.set('version', installed.version);
          touched = true;
        }
        if (item.get('latency') === undefined && installed.latency > 0) {
          item.set('latency', installed.latency);
          touched = true;
        }
        if (!touched) continue;
        changed = true;
        edits.push({
          file: track.path,
          plugin: name,
          format: installed.format,
          identifier: installed.identifier,
          version: installed.version,
        });
      }

      if (changed) {
        canonicalizeDocument(doc, trackOrder);
        writeFileSync(path, stringifyDocument(doc));
      }
    }
  }
  return { edits, problems };
}

export function pinCommand(
  root: string,
  options: { prefer?: 'au' | 'vst3'; update?: boolean },
): boolean {
  const inventory = readInventory(root);
  if (inventory === undefined) {
    console.error('no scan yet — field plugins scan');
    return false;
  }
  const project = loadProject(root);
  const { edits, problems } = pinProject(project, inventory, options);
  for (const edit of edits) {
    console.log(`pinned ${edit.plugin} → ${edit.format} ${edit.identifier} ${edit.version} (${edit.file})`);
  }
  for (const problem of problems) {
    console.error(`${problem.file}: ${problem.message}`);
  }
  if (edits.length === 0 && problems.length === 0) console.log('nothing to pin');
  return problems.length === 0;
}

// The first-check hook (decision 2): pin whatever a scan can resolve
// before validation runs, so `field check` on a freshly authored
// `- plugin: <name>` line writes the identity back and then judges the
// pinned file. No inventory, no edits — validate reports the unpinned
// insert and names the scan command.
export function pinBeforeCheck(root: string): PinEdit[] {
  const inventoryPath = join(root, '.field', 'plugins.json');
  if (!existsSync(inventoryPath)) return [];
  const inventory = readInventory(root);
  if (inventory === undefined) return [];
  const project = loadProject(root);
  const unpinned = project.songs.some((song) =>
    song.tracks.some((track) =>
      track.data.inserts.some(
        (insert) =>
          'plugin' in insert && insert.au === undefined && insert.vst3 === undefined,
      ),
    ),
  );
  if (!unpinned) return [];
  return pinProject(project, inventory).edits;
}
