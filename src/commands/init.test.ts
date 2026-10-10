import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './init.js';

// The .gitattributes init writes is what stands between a project's
// content hashes and the platform's line-ending config: asset pins,
// .scd action keys, and check's byte-wise formatting gate all read
// working-tree bytes (windows-portability.md §1.1), and a project
// cloned to a Windows machine with core.autocrlf=true gets CRLF unless
// the project itself pins LF.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-init-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('init .gitattributes', () => {
  it('pins LF for text before the binary overrides, so hashes survive any checkout', () => {
    init({ dir: root, name: 'test-album' });
    const lines = readFileSync(join(root, '.gitattributes'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));

    // The order is the mechanism: last match wins, so the blanket LF
    // rule must precede every binary override it would otherwise
    // reconvert.
    expect(lines[0]).toBe('* text=auto eol=lf');
    for (const ext of ['wav', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'caf']) {
      expect(lines).toContain(`*.${ext} filter=lfs diff=lfs merge=lfs -text`);
    }
    // Plugin state blobs hash to their own filename and refuse when the
    // bytes move (plugins.ts); they must never ride the binary
    // heuristic.
    expect(lines).toContain('*.state binary');
  });
});
