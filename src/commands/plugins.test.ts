// The pinning write-back and the hosted-insert check rules
// (plugin-hosting.md decisions 2, 3, 4, 6, 9): repository-fact
// validation runs everywhere; the inventory here is synthetic, so these
// tests need no plugin installed and no daemon built.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from './create.js';
import { init } from './init.js';
import { pinProject, pinBeforeCheck } from './plugins.js';
import { sha256Text } from '../hash.js';
import { loadProject, verifyAssetHashes } from '../model/project.js';
import type { PluginInventory } from '../audio/plugins.js';

let root: string;

const inventory: PluginInventory = {
  plugins: [
    {
      format: 'vst3',
      name: 'Field Fixture',
      identifier: '1beeb215',
      version: '1.0.0',
      manufacturer: 'Field',
      path: '/somewhere/Field Fixture.vst3',
      latency: 0,
      params: [
        { id: '3165055', name: 'Gain', label: 'dB' },
        { id: '110628959', name: 'Trim', label: 'dB' },
        { id: '110628960', name: 'Trim', label: 'dB' },
      ],
    },
  ],
  failed: [],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-plugins-test-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTrack(yaml: string, name = 'lead'): string {
  const path = join(root, 'songs/opener/tracks', `${name}.yaml`);
  writeFileSync(path, yaml);
  return path;
}

function writeInventory(): void {
  mkdirSync(join(root, '.field'), { recursive: true });
  writeFileSync(join(root, '.field', 'plugins.json'), JSON.stringify(inventory));
}

function stateBlob(content: string, slugDir = 'field-fixture'): string {
  const sha = sha256Text(content);
  const dir = join(root, 'shared', 'plugins', slugDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha}.state`), content);
  return sha;
}

describe('pinProject (decision 2)', () => {
  it('writes identity, version and latency back, keeping comments, and is idempotent', () => {
    const path = writeTrack(
      [
        'name: lead',
        'inserts:',
        '  # squash before the room',
        '  - plugin: Field Fixture',
        '    params:',
        '      Gain: 4.5',
        'inputs: []',
        '',
      ].join('\n'),
    );

    const first = pinProject(loadProject(root), inventory);
    expect(first.problems).toEqual([]);
    expect(first.edits).toHaveLength(1);
    expect(first.edits[0]).toMatchObject({ format: 'vst3', identifier: '1beeb215', version: '1.0.0' });

    const written = readFileSync(path, 'utf8');
    expect(written).toContain('vst3: 1beeb215');
    expect(written).toContain('version: 1.0.0');
    expect(written).toContain('# squash before the room');
    expect(written).not.toContain('latency:'); // zero-latency stays unwritten

    const second = pinProject(loadProject(root), inventory);
    expect(second.edits).toEqual([]);
  });

  it('reports an unknown name as a problem, not an exception', () => {
    writeTrack('name: lead\ninserts:\n  - plugin: Missing Thing\ninputs: []\n');
    const { edits, problems } = pinProject(loadProject(root), inventory);
    expect(edits).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain('no scanned plugin is named "Missing Thing"');
  });

  it('pin --au switches a vst3-pinned entry across formats (Codex)', () => {
    const path = writeTrack(
      'name: lead\ninserts:\n  - plugin: Field Fixture\n    vst3: 1beeb215\n    version: 1.0.0\ninputs: []\n',
    );
    const both: PluginInventory = {
      plugins: [
        inventory.plugins[0]!,
        { ...inventory.plugins[0]!, format: 'au', identifier: 'aufx/Ffx1/Fldf' },
      ],
      failed: [],
    };
    const { edits, problems } = pinProject(loadProject(root), both, { prefer: 'au' });
    expect(problems).toEqual([]);
    expect(edits).toHaveLength(1);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('au: aufx/Ffx1/Fldf');
    expect(written).not.toContain('vst3:');
  });

  it('refuses to pin a plugin that reports no version (Codex)', () => {
    writeTrack('name: lead\ninserts:\n  - plugin: Field Fixture\ninputs: []\n');
    const versionless: PluginInventory = {
      plugins: [{ ...inventory.plugins[0]!, version: '' }],
      failed: [],
    };
    const { edits, problems } = pinProject(loadProject(root), versionless);
    expect(edits).toEqual([]);
    expect(problems[0]!.message).toContain('reports no version');
  });

  it('build pins too: loadValid writes the identity before validating (Codex)', async () => {
    const path = writeTrack('name: lead\ninserts:\n  - plugin: Field Fixture\ninputs: []\n');
    writeInventory();
    const { loadValid } = await import('./build.js');
    const { warnings } = loadValid(root);
    expect(warnings.some((w) => w.includes('pinned Field Fixture'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('vst3: 1beeb215');
  });

  it('keeps the built-in arms their own diagnostics through the dispatch (minjudd)', () => {
    writeTrack('name: lead\ninserts:\n  - effect: reverb\n    decayy: 2.0\ninputs: []\n');
    const typo = loadProject(root).diagnostics.map((d) => d.message);
    expect(typo.some((m) => m.includes('decayy'))).toBe(true);

    writeTrack('name: lead\ninserts:\n  - effect: revrb\n    mix: 0.3\ninputs: []\n');
    const wrongEffect = loadProject(root).diagnostics.map((d) => d.message);
    expect(wrongEffect.some((m) => m.includes('reverb'))).toBe(true);
  });

  it('updates a drifted version only under --update (decision 9)', () => {
    const path = writeTrack(
      'name: lead\ninserts:\n  - plugin: Field Fixture\n    vst3: 1beeb215\n    version: 0.9.0\ninputs: []\n',
    );
    const stay = pinProject(loadProject(root), inventory);
    expect(stay.edits).toEqual([]);
    expect(readFileSync(path, 'utf8')).toContain('version: 0.9.0');

    const move = pinProject(loadProject(root), inventory, { update: true });
    expect(move.edits).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toContain('version: 1.0.0');
  });

  it('pinBeforeCheck is inert without an inventory', () => {
    writeTrack('name: lead\ninserts:\n  - plugin: Field Fixture\ninputs: []\n');
    expect(pinBeforeCheck(root).edits).toEqual([]);
    writeInventory();
    expect(pinBeforeCheck(root).edits).toHaveLength(1);
  });

  it('check surfaces pin problems, not just the generic unpinned error (Bugbot)', async () => {
    writeTrack('name: lead\ninserts:\n  - plugin: Field Fixture\ninputs: []\n');
    const twin: PluginInventory = {
      plugins: [
        inventory.plugins[0]!,
        { ...inventory.plugins[0]!, identifier: 'deadbeef', path: '/elsewhere/Fixture.vst3' },
      ],
      failed: [],
    };
    mkdirSync(join(root, '.field'), { recursive: true });
    writeFileSync(join(root, '.field', 'plugins.json'), JSON.stringify(twin));
    const { check } = await import('./check.js');
    const result = await check(root);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) => d.message.includes('matches 2 scanned plugins')),
    ).toBe(true);
  });
});

describe('hosted-insert check rules', () => {
  it('flags an unpinned insert as an error naming the scan', () => {
    writeTrack('name: lead\ninserts:\n  - plugin: Field Fixture\ninputs: []\n');
    const project = loadProject(root);
    expect(project.diagnostics.some((d) => d.message.includes('is not pinned'))).toBe(true);
  });

  it('requires ids when one chain repeats a plugin (decision 6), scoped per track', () => {
    writeTrack(
      [
        'name: lead',
        'inserts:',
        '  - plugin: Field Fixture',
        '    vst3: 1beeb215',
        '    version: 1.0.0',
        '  - plugin: Field Fixture',
        '    vst3: 1beeb215',
        '    version: 1.0.0',
        'inputs: []',
        '',
      ].join('\n'),
    );
    // The same plugin on another track needs nothing.
    writeTrack(
      'name: pad\ninserts:\n  - plugin: Field Fixture\n    vst3: 1beeb215\n    version: 1.0.0\ninputs: []\n',
      'pad',
    );
    const project = loadProject(root);
    const messages = project.diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes('appears 2 times in one chain'))).toBe(true);
    expect(messages.filter((m) => m.includes('appears'))).toHaveLength(1);
  });

  it('resolves state refs: missing errors, ambiguity errors, misplaced warns (decision 4)', async () => {
    const sha = stateBlob('{"offset":0.1}');
    writeTrack(
      [
        'name: lead',
        'inserts:',
        '  - plugin: Field Fixture',
        '    vst3: 1beeb215',
        '    version: 1.0.0',
        `    state: ${sha.slice(0, 12)}`,
        'inputs: []',
        '',
      ].join('\n'),
    );
    expect(loadProject(root).diagnostics).toEqual([]);

    // Misplaced: correct content, unconventional directory — a warning.
    rmSync(join(root, 'shared', 'plugins'), { recursive: true });
    stateBlob('{"offset":0.1}', 'somewhere-else');
    const misplaced = loadProject(root);
    const warning = misplaced.diagnostics.find((d) => d.message.includes('write-time convention'));
    expect(warning?.severity).toBe('warning');

    // Missing entirely: an error.
    rmSync(join(root, 'shared', 'plugins'), { recursive: true });
    const missing = loadProject(root);
    expect(missing.diagnostics.some((d) => d.message.includes('no state blob matching'))).toBe(
      true,
    );
  });

  it('verifyAssetHashes refuses a blob that does not hash to its filename', async () => {
    const sha = stateBlob('{"offset":0.1}');
    const path = join(root, 'shared', 'plugins', 'field-fixture', `${sha}.state`);
    writeFileSync(path, '{"offset":0.2}'); // drift
    const diagnostics = await verifyAssetHashes(loadProject(root));
    expect(diagnostics.some((d) => d.message.includes('does not hash to its filename'))).toBe(true);
  });

  it('validates params against the inventory when installed, defers when not (decision 3)', () => {
    writeTrack(
      [
        'name: lead',
        'inserts:',
        '  - plugin: Field Fixture',
        '    vst3: 1beeb215',
        '    version: 1.0.0',
        '    params:',
        '      Gian: 3',
        '      Trim: 2',
        'inputs: []',
        '',
      ].join('\n'),
    );
    // No inventory: repository facts only — the typo is deferred.
    expect(loadProject(root).diagnostics).toEqual([]);

    writeInventory();
    const messages = loadProject(root).diagnostics.map((d) => d.message);
    expect(messages.some((m) => m.includes('has no parameter "Gian"'))).toBe(true);
    expect(
      messages.some((m) => m.includes('spell it Trim#110628959 or Trim#110628960')),
    ).toBe(true);
  });

  it('warns on version drift against the inventory without failing the gate (decision 9)', () => {
    writeTrack(
      'name: lead\ninserts:\n  - plugin: Field Fixture\n    vst3: 1beeb215\n    version: 0.9.0\ninputs: []\n',
    );
    writeInventory();
    const drift = loadProject(root).diagnostics.find((d) =>
      d.message.includes('pinned at 0.9.0; installed is 1.0.0'),
    );
    expect(drift?.severity).toBe('warning');
  });
});
