import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { check } from './check.js';
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

describe('the project license (remote.md §3.5)', () => {
  it('writes license after name when given, and no line without one', () => {
    init({ dir: join(root, 'licensed'), name: 'licensed', license: 'CC-BY-4.0' });
    expect(readFileSync(join(root, 'licensed/field.yaml'), 'utf8')).toBe(
      'field: 1\nname: licensed\nlicense: CC-BY-4.0\nsample_rate: 48000\n',
    );
    init({ dir: join(root, 'plain'), name: 'plain' });
    expect(readFileSync(join(root, 'plain/field.yaml'), 'utf8')).not.toContain('license');
  });

  it('refuses a license that is not an SPDX identifier, in init and in check', async () => {
    expect(() => init({ dir: join(root, 'bad'), name: 'bad', license: 'CC BY 4.0' })).toThrow(
      'license "CC BY 4.0" must be an SPDX license identifier',
    );
    init({ dir: join(root, 'edited'), name: 'edited' });
    writeFileSync(join(root, 'edited/field.yaml'), 'field: 1\nname: edited\nlicense: CC BY 4.0\nsample_rate: 48000\n');
    const { diagnostics } = await check(join(root, 'edited'));
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(/must be an SPDX license identifier/);
    writeFileSync(join(root, 'edited/field.yaml'), 'field: 1\nname: edited\nlicense: LicenseRef-mine\nsample_rate: 48000\n');
    expect((await check(join(root, 'edited'))).diagnostics).toEqual([]);
  });
});
