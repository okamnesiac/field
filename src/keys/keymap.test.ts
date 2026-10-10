import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtinKeymapDir,
  builtinKeymapNames,
  KeymapError,
  loadKeymap,
  resolveKeymapSource,
  watchKeymap,
  type ReloadResult,
} from './keymap.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-keymap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolving a keymap', () => {
  it('defaults to musical-typing', () => {
    expect(resolveKeymapSource(undefined, {})).toEqual({
      kind: 'builtin',
      name: 'musical-typing',
      path: join(builtinKeymapDir(), 'musical-typing.yaml'),
    });
  });

  it('lists the built-ins', () => {
    expect(builtinKeymapNames()).toContain('musical-typing');
  });

  it('resolves a bare name only to a built-in', () => {
    writeFileSync(join(dir, 'mine.yaml'), 'name: mine\nnotes: { KeyA: 0 }\n');
    expect(() => resolveKeymapSource('mine', {}, { cwd: dir })).toThrow(
      /no built-in keymap named "mine" \(built-ins: .*musical-typing.*\); .*give a path .*\.\/mine\.yaml/,
    );
  });

  it('treats a value with a slash, or ending in .yaml, as a path', () => {
    expect(resolveKeymapSource('./mine.yaml', {}, { cwd: dir })).toEqual({ kind: 'file', path: join(dir, 'mine.yaml') });
    expect(resolveKeymapSource('mine.yaml', {}, { cwd: dir })).toEqual({ kind: 'file', path: join(dir, 'mine.yaml') });
    expect(resolveKeymapSource('maps/mine', {}, { cwd: dir })).toEqual({ kind: 'file', path: join(dir, 'maps/mine') });
  });

  it('expands a leading ~/ to the home directory', () => {
    expect(resolveKeymapSource('~/keymaps/mine.yaml', {}, { home: dir })).toEqual({
      kind: 'file',
      path: join(dir, 'keymaps/mine.yaml'),
    });
  });

  it('takes FIELD_KEYMAP when no flag is given, and the flag over it', () => {
    expect(resolveKeymapSource(undefined, { FIELD_KEYMAP: '~/mine.yaml' }, { home: dir })).toEqual({
      kind: 'file',
      path: join(dir, 'mine.yaml'),
    });
    expect(resolveKeymapSource('musical-typing', { FIELD_KEYMAP: '~/mine.yaml' }, { home: dir }).kind).toBe('builtin');
    expect(resolveKeymapSource(undefined, { FIELD_KEYMAP: '' }).kind).toBe('builtin');
  });
});

describe('loading a keymap', () => {
  it('names the file and each problem', () => {
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, 'name: bad\nnotes: { KeyA: 0 }\ncontrols: { KeyA: panic, Escape: panic }\n');
    expect(() => loadKeymap(path)).toThrow(KeymapError);
    try {
      loadKeymap(path);
    } catch (err) {
      const problems = (err as KeymapError).problems;
      expect(problems.some((p) => p.startsWith('controls.KeyA: KeyA is both a note and a control'))).toBe(true);
      expect(problems.some((p) => p.startsWith('controls.Escape: Escape is reserved'))).toBe(true);
      expect((err as KeymapError).message.startsWith(`${path}:\n`)).toBe(true);
    }
  });

  it('reports YAML syntax errors and a missing file', () => {
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'name: [unclosed\n');
    expect(() => loadKeymap(broken)).toThrow(KeymapError);
    expect(() => loadKeymap(join(dir, 'absent.yaml'))).toThrow(/no such file/);
  });
});

describe('reloading a keymap on save', () => {
  function nextReload(results: ReloadResult[], count: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = (): void => {
        if (results.length >= count) resolve();
        else if (Date.now() > deadline) reject(new Error(`no reload ${count} within 5 s`));
        else setTimeout(poll, 20);
      };
      poll();
    });
  }

  // Many editors write a temporary file and rename it over the keymap;
  // a watch on the file itself would end at the first such save.
  function saveByRename(path: string, text: string): void {
    const temp = `${path}.tmp-${Math.random().toString(36).slice(2)}`;
    writeFileSync(temp, text);
    renameSync(temp, path);
  }

  it('applies two rename-on-save edits in a row, and keeps the keymap through an invalid one', async () => {
    const path = join(dir, 'mine.yaml');
    writeFileSync(path, 'name: mine\nnotes: { KeyA: 0 }\n');
    const results: ReloadResult[] = [];
    const stop = watchKeymap(path, (r) => results.push(r), 20);
    try {
      saveByRename(path, 'name: mine\nnotes: { KeyA: 2 }\n');
      await nextReload(results, 1);
      const first = results.at(-1)!;
      expect('keymap' in first && first.keymap.notes.get('KeyA')).toEqual([2]);

      saveByRename(path, 'name: mine\nnotes: { KeyA: 4 }\n');
      await nextReload(results, 2);
      const second = results.at(-1)!;
      expect('keymap' in second && second.keymap.notes.get('KeyA')).toEqual([4]);

      saveByRename(path, 'name: mine\nnotes: { KeyA: 0 }\ncontrols: { KeyA: { transpose: 12 } }\n');
      await nextReload(results, 3);
      const third = results.at(-1)!;
      expect('error' in third && third.error.problems.join('\n')).toMatch(/KeyA is both a note and a control/);
    } finally {
      stop();
    }
  });

  it('ignores changes to other files in the directory', async () => {
    const path = join(dir, 'mine.yaml');
    writeFileSync(path, 'name: mine\nnotes: { KeyA: 0 }\n');
    const results: ReloadResult[] = [];
    const stop = watchKeymap(path, (r) => results.push(r), 20);
    try {
      writeFileSync(join(dir, 'other.yaml'), 'name: other\nnotes: { KeyA: 0 }\n');
      await new Promise((r) => setTimeout(r, 300));
      expect(results).toEqual([]);
    } finally {
      stop();
    }
  });
});
