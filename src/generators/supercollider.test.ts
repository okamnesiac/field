import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sclangCommand } from './supercollider.js';

// The sclang lookup that renders and the `field keys` voice host share,
// exercised per platform against real files in a temp directory. The
// platform is a parameter so the Windows rules run everywhere
// (windows-portability.md §7.2).

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-sclang-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function executable(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  chmodSync(path, 0o755);
  return path;
}

describe('sclangCommand', () => {
  it('finds sclang on PATH by name on macOS and Linux', () => {
    const sclang = executable(join(root, 'bin', 'sclang'));
    expect(sclangCommand({ PATH: join(root, 'bin') }, 'linux')).toBe(sclang);
  });

  it('finds sclang.exe on PATH on Windows, through PATHEXT', () => {
    const sclang = executable(join(root, 'bin', 'sclang.exe'));
    expect(sclangCommand({ PATH: join(root, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(sclang);
  });

  it('reads Windows variables without regard to case, as a copied environment spells them', () => {
    // Windows names PATH `Path`; a copy of process.env loses the
    // case-insensitive lookup, so the search must not depend on spelling.
    const sclang = executable(join(root, 'bin', 'sclang.exe'));
    expect(sclangCommand({ Path: join(root, 'bin'), PathExt: '.EXE' }, 'win32')).toBe(sclang);
  });

  it('does not take an extensionless sclang on Windows, which cannot run there', () => {
    executable(join(root, 'bin', 'sclang'));
    expect(() => sclangCommand({ PATH: join(root, 'bin'), ProgramFiles: join(root, 'none') }, 'win32')).toThrow(
      'sclang not found',
    );
  });

  it('reads a native Windows FIELD_SCLANG as a path, not a name to search for', () => {
    // A file named exactly like the override sits on PATH. Read as a name,
    // the search would find it; read as a path, it is missing.
    const override = 'C:\\SuperCollider\\sclang.exe';
    executable(join(root, 'bin', override));
    expect(() => sclangCommand({ FIELD_SCLANG: override, PATH: join(root, 'bin') }, 'win32')).toThrow(
      `FIELD_SCLANG points at a missing binary: ${override}`,
    );
  });

  it('searches PATH for a bare FIELD_SCLANG name on Windows', () => {
    const wrapper = executable(join(root, 'bin', 'sclang-wrapper.cmd'));
    expect(sclangCommand({ FIELD_SCLANG: 'sclang-wrapper', PATH: join(root, 'bin') }, 'win32')).toBe(wrapper);
  });

  it('falls back to the newest SuperCollider under Program Files on Windows', () => {
    // 3.13.0 is newer than 3.9.3, which a plain string sort gets backwards.
    executable(join(root, 'Program Files', 'SuperCollider-3.9.3', 'sclang.exe'));
    const newest = executable(join(root, 'Program Files', 'SuperCollider-3.13.0', 'sclang.exe'));
    expect(sclangCommand({ PATH: join(root, 'empty'), ProgramFiles: join(root, 'Program Files') }, 'win32')).toBe(
      newest,
    );
  });

  it('names FIELD_SCLANG when nothing is found', () => {
    expect(() => sclangCommand({ PATH: join(root, 'empty') }, 'linux')).toThrow('set FIELD_SCLANG');
  });
});
