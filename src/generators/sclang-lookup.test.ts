import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sclangCommand } from './supercollider.js';

// Finding sclang (windows-portability.md §7.2): FIELD_SCLANG, then PATH,
// then where SuperCollider installs. The platform is a parameter, so the
// Windows rules run here against real files in a temporary directory.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-sclang-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function program(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  chmodSync(path, 0o755);
  return path;
}

describe('sclangCommand', () => {
  it('finds sclang.exe on PATH on Windows, and only sclang elsewhere', () => {
    const exe = program(join(dir, 'bin', 'sclang.exe'));
    expect(sclangCommand({ PATH: join(dir, 'bin') }, 'win32')).toBe(exe);
    expect(() => sclangCommand({ PATH: join(dir, 'bin') }, 'linux')).toThrow('sclang not found on PATH');
  });

  it('takes a FIELD_SCLANG with a backslash as a path, not a name to look up', () => {
    // A file name with a backslash in it stands in for a native Windows path.
    const native = program(join(dir, 'SuperCollider\\sclang.exe'));
    expect(sclangCommand({ FIELD_SCLANG: native, PATH: '' }, 'win32')).toBe(native);
    expect(() => sclangCommand({ FIELD_SCLANG: 'C:\\Program Files\\SuperCollider-3.13.0\\sclang.exe', PATH: '' }, 'win32')).toThrow(
      'FIELD_SCLANG points at a missing binary: C:\\Program Files\\SuperCollider-3.13.0\\sclang.exe',
    );
  });

  it('falls back to the newest SuperCollider under Program Files on Windows', () => {
    for (const version of ['3.9.1', '3.13.0', '3.12.2']) program(join(dir, `SuperCollider-${version}`, 'sclang.exe'));
    mkdirSync(join(dir, 'Something Else'));
    expect(sclangCommand({ PATH: '', ProgramFiles: dir }, 'win32')).toBe(join(dir, 'SuperCollider-3.13.0', 'sclang.exe'));
    expect(() => sclangCommand({ PATH: '', ProgramFiles: join(dir, 'missing') }, 'win32')).toThrow('sclang not found');
  });

  it('looks in no install location off macOS and Windows', () => {
    expect(() => sclangCommand({ PATH: '' }, 'linux')).toThrow('sclang not found on PATH');
  });
});
