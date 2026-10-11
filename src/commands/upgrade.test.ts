import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installerPath, upgrade } from './upgrade.js';

// `field upgrade` is a doorway to install.sh and nothing else
// (install.md §2.5): it has to find the right installer, hand it the
// target, and give back its exit status. These run real bash against a
// stand-in installer, because the handoff is the whole command.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'field-upgrade-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// An installer that records its arguments and exits with a known status.
function standIn(dir: string, status: number): { installer: string; argsFile: string } {
  const installer = join(dir, 'install.sh');
  const argsFile = join(dir, 'args');
  writeFileSync(installer, `printf '%s\\n' "$#:$*" > "$(dirname "$0")/args"\nexit ${status}\n`);
  return { installer, argsFile };
}

describe('field upgrade', () => {
  it('finds the install.sh beside the package it runs from', () => {
    expect(installerPath()).toBe(join(packageRoot, 'install.sh'));
    expect(existsSync(installerPath())).toBe(true);
  });

  it('hands the installer its target and returns its exit status', () => {
    const { installer, argsFile } = standIn(scratch, 3);
    const lines: string[] = [];
    expect(upgrade('status', { installer, err: (line) => lines.push(line) })).toBe(3);
    expect(readFileSync(argsFile, 'utf8')).toBe('1:status\n');
    expect(lines).toEqual([`+ ${installer} status`]);
  });

  it('passes no target when given none, so the installer picks its default', () => {
    const { installer, argsFile } = standIn(scratch, 0);
    expect(upgrade(undefined, { installer, err: () => {} })).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('0:\n');
  });

  it('runs the installer through bash, so a checkout without the execute bit still upgrades', () => {
    // writeFileSync leaves the stand-in at 0644.
    const { installer } = standIn(scratch, 0);
    expect(upgrade('cli', { installer, err: () => {} })).toBe(0);
  });

  it('quotes a path that needs it in the line it prints', () => {
    const dir = join(scratch, "a checkout's home");
    mkdirSync(dir);
    const { installer } = standIn(dir, 0);
    const lines: string[] = [];
    upgrade('all', { installer, err: (line) => lines.push(line) });
    expect(lines).toEqual([`+ '${scratch}/a checkout'\\''s home/install.sh' all`]);
  });

  it('refuses when there is no installer, rather than guessing at another', () => {
    const installer = join(scratch, 'install.sh');
    expect(() => upgrade(undefined, { installer, err: () => {} })).toThrow(
      `cannot upgrade: ${installer} does not exist`,
    );
  });
});
