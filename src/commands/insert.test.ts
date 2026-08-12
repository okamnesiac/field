import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginInfo } from '../audio/plugins.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { addInsert, chooserItems, positionLabels } from './insert.js';

const entry = (
  name: string,
  format: 'au' | 'vst3',
  identifier: string,
  overrides: Partial<PluginInfo> = {},
): PluginInfo => ({
  format,
  name,
  identifier,
  version: '2.1.0',
  manufacturer: 'Test',
  path: format === 'au' ? `AudioUnit:Effects/${identifier}` : `/plugins/${name}.vst3`,
  latency: 0,
  params: [],
  ...overrides,
});

describe('field insert add', () => {
  let root: string;

  const writeInventory = (plugins: PluginInfo[]): void => {
    mkdirSync(join(root, '.field'), { recursive: true });
    writeFileSync(join(root, '.field/plugins.json'), JSON.stringify({ plugins, failed: [] }));
  };

  const lead = (): string => join(root, 'songs/opener/tracks/lead.yaml');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-insert-add-'));
    init({ dir: root, name: 'test-album' });
    createSong(root, 'opener');
    writeFileSync(lead(), 'name: lead\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a pinned insert and keeps hand-written comments', async () => {
    writeFileSync(lead(), '# keep me\nname: lead # and me\n');
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test', { latency: 64 })]);
    const outcome = await addInsert(root, 'lead', { plugin: 'Verbatron' });
    expect(outcome.position).toBe(1);
    expect(outcome.chainLength).toBe(1);
    expect(outcome.handle).toBe('Verbatron');
    const text = readFileSync(lead(), 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('# and me');
    expect(text).toContain('plugin: Verbatron');
    expect(text).toContain('au: aufx/vrbt/test');
    expect(text).toContain('version: 2.1.0');
    expect(text).toContain('latency: 64'); // tool-written, like version
  });

  it('omits latency when the scan reports zero', async () => {
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    await addInsert(root, 'lead', { plugin: 'Verbatron' });
    expect(readFileSync(lead(), 'utf8')).not.toContain('latency');
  });

  it('appends at the end by default and honors --at', async () => {
    writeFileSync(
      lead(),
      ['name: lead', 'inserts:', '  - effect: eq', '    bands:', '      - type: highshelf', '        frequency: 8000', '        gain_db: 2', ''].join('\n'),
    );
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test'), entry('Alpha', 'au', 'aufx/alfa/test')]);
    const appended = await addInsert(root, 'lead', { plugin: 'Verbatron' });
    expect(appended.position).toBe(2); // non-TTY, no flag: the end, silently
    const topped = await addInsert(root, 'lead', { plugin: 'Alpha', at: '1' });
    expect(topped.position).toBe(1);
    await expect(addInsert(root, 'lead', { plugin: 'Verbatron', at: '9', id: 'x' })).rejects.toThrow(
      /not a position in a chain of 3/,
    );
  });

  it('refuses without an inventory, naming the scan', async () => {
    await expect(addInsert(root, 'lead', { plugin: 'Verbatron' })).rejects.toThrow(
      /no scan yet — field plugins scan/,
    );
  });

  it('refuses an unnamed plugin without a chooser, naming the command line', async () => {
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    await expect(addInsert(root, 'lead', {})).rejects.toThrow(/field insert add lead "<plugin>"/);
  });

  it('refuses a versionless plugin with the pinner-shaped message', async () => {
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test', { version: '' })]);
    await expect(addInsert(root, 'lead', { plugin: 'Verbatron' })).rejects.toThrow(
      /reports no version; it cannot be pinned/,
    );
  });

  it('resolves a both-formats name by preference, and refuses a same-format tie', async () => {
    writeInventory([
      entry('Duo', 'au', 'aufx/duoa/test'),
      entry('Duo', 'vst3', 'aabbccdd'),
    ]);
    const picked = await addInsert(root, 'lead', { plugin: 'Duo', prefer: 'vst3' });
    expect(picked.plugin!.format).toBe('vst3');
    writeInventory([
      entry('Tie', 'vst3', '11111111'),
      entry('Tie', 'vst3', '22222222'),
    ]);
    await expect(addInsert(root, 'lead', { plugin: 'Tie', prefer: 'vst3' })).rejects.toThrow(
      /matches 2 scanned plugins/,
    );
  });

  it('sorts chooser rows recents-first and disables versionless rows', async () => {
    writeFileSync(
      lead(),
      ['name: lead', 'inserts:', '  - plugin: Zeta', '    au: aufx/zeta/test', '    version: 2.1.0', ''].join('\n'),
    );
    writeInventory([
      entry('Alpha', 'au', 'aufx/alfa/test'),
      entry('NoVersion', 'au', 'aufx/nver/test', { version: '' }),
      entry('Zeta', 'au', 'aufx/zeta/test'),
    ]);
    let seen: string[] = [];
    const outcome = await addInsert(root, 'lead', {
      hooks: {
        choosePlugin: (items) => {
          seen = items.map((i) => i.label);
          expect(items.find((i) => i.label.startsWith('NoVersion'))!.disabled).toMatch(/no version/);
          return Promise.resolve(undefined); // cancel
        },
      },
    });
    expect(outcome.cancelled).toBe(true);
    // Zeta is pinned in the project already, so it sorts above Alpha.
    expect(seen[0]!.startsWith('Zeta')).toBe(true);
    // A cancelled chooser writes nothing.
    expect(readFileSync(lead(), 'utf8')).not.toContain('Alpha');
  });

  it('adds the identifier to rows that collide on name, format, and version', () => {
    const items = chooserItems(
      { plugins: [entry('Twin', 'vst3', '11111111'), entry('Twin', 'vst3', '22222222')] },
      { root, songs: [], diagnostics: [] },
    );
    expect(items[0]!.label).toContain('11111111');
    expect(items[1]!.label).toContain('22222222');
  });

  it('offers positions by name with the end as default, and places the pick', async () => {
    writeFileSync(
      lead(),
      [
        'name: lead',
        'inserts:',
        '  - plugin: Zeta',
        '    au: aufx/zeta/test',
        '    version: 2.1.0',
        '',
      ].join('\n'),
    );
    writeInventory([entry('Alpha', 'au', 'aufx/alfa/test'), entry('Zeta', 'au', 'aufx/zeta/test')]);
    const outcome = await addInsert(root, 'lead', {
      plugin: 'Alpha',
      hooks: {
        choosePosition: (labels, defaultIndex) => {
          expect(labels).toEqual(positionLabels(['Zeta']));
          expect(defaultIndex).toBe(labels.length - 1);
          return Promise.resolve(0); // before Zeta
        },
      },
    });
    expect(outcome.position).toBe(1);
    const text = readFileSync(lead(), 'utf8');
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Zeta'));
  });

  it('prompts ids for the whole identity group and discloses the backfill', async () => {
    writeFileSync(
      lead(),
      ['name: lead', 'inserts:', '  - plugin: Verbatron', '    au: aufx/vrbt/test', '    version: 2.1.0', ''].join('\n'),
    );
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    const asked: string[] = [];
    const answers = ['crush', 'slap'];
    const outcome = await addInsert(root, 'lead', {
      plugin: 'Verbatron',
      hooks: {
        askId: (prompt) => {
          asked.push(prompt);
          return Promise.resolve(answers.shift());
        },
      },
    });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/existing "Verbatron" at position 1/);
    expect(outcome.backfilled).toEqual(['crush']);
    expect(outcome.handle).toBe('slap');
    const text = readFileSync(lead(), 'utf8');
    expect(text).toContain('id: crush');
    expect(text).toContain('id: slap');
  });

  it('treats an unpinned incumbent as the same plugin (minjudd on #155)', async () => {
    // The group that needs handles is the one check builds *after*
    // pinBeforeCheck pins the incumbent — matching only the identity
    // let a hand-authored `- plugin: X` slip past, and the command
    // wrote exactly the file §2 promises it will not.
    writeFileSync(lead(), ['name: lead', 'inserts:', '  - plugin: Verbatron', ''].join('\n'));
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    const answers = ['crush', 'slap'];
    const outcome = await addInsert(root, 'lead', {
      plugin: 'Verbatron',
      hooks: { askId: () => Promise.resolve(answers.shift()) },
    });
    expect(outcome.backfilled).toEqual(['crush']);
    expect(outcome.handle).toBe('slap');
    const text = readFileSync(lead(), 'utf8');
    expect(text).toContain('id: crush');
    expect(text).toContain('id: slap');
  });

  it('refuses the duplicate case without a TTY, and takes --id when incumbents are id-ed', async () => {
    writeFileSync(
      lead(),
      ['name: lead', 'inserts:', '  - plugin: Verbatron', '    id: crush', '    au: aufx/vrbt/test', '    version: 2.1.0', ''].join('\n'),
    );
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    await expect(addInsert(root, 'lead', { plugin: 'Verbatron' })).rejects.toThrow(
      /every instance needs an id/,
    );
    await expect(
      addInsert(root, 'lead', { plugin: 'Verbatron', id: 'crush' }),
    ).rejects.toThrow(/duplicate insert id "crush"/);
    const outcome = await addInsert(root, 'lead', { plugin: 'Verbatron', id: 'slap' });
    expect(outcome.handle).toBe('slap');
  });

  it('resolves bare track names project-wide and demands a qualifier on collision', async () => {
    createSong(root, 'closer');
    writeFileSync(join(root, 'songs/closer/tracks/lead.yaml'), 'name: lead\n');
    writeInventory([entry('Verbatron', 'au', 'aufx/vrbt/test')]);
    await expect(addInsert(root, 'lead', { plugin: 'Verbatron' })).rejects.toThrow(
      /qualify it: closer\/lead or opener\/lead/,
    );
    const qualified = await addInsert(root, 'closer/lead', { plugin: 'Verbatron' });
    expect(qualified.song).toBe('closer');
    await expect(addInsert(root, 'nowhere', { plugin: 'Verbatron' })).rejects.toThrow(
      /no track named "nowhere"/,
    );
    await expect(addInsert(root, 'opener/nowhere', { plugin: 'Verbatron' })).rejects.toThrow(
      /no track named "nowhere"/,
    );
  });
});
