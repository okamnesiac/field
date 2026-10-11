import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileStore, keychainStore, resolveToken, type SecurityRunner } from './credentials.js';

// Credentials never touch the real keychain (remote.md §7): `security` is
// injected, and the file fallback runs under a temp directory.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-credentials-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fileStore', () => {
  it('round-trips a token per remote, mode 0600', () => {
    const path = join(dir, 'home', '.field', 'credentials');
    const store = fileStore(path);
    expect(store.read('https://audiofield.io')).toBeUndefined();
    store.write('https://audiofield.io', { token: 'abc' });
    store.write('https://staging.audiofield.io', { token: 'def' });
    expect(store.read('https://audiofield.io')).toEqual({ token: 'abc' });
    expect(store.read('https://staging.audiofield.io')).toEqual({ token: 'def' });
    // A token is a secret in a home directory: only its owner reads it.
    // Windows reports no POSIX mode bits (chmod only toggles read-only
    // there), so the profile directory's ACL is what protects the file.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'home', '.field')).mode & 0o777).toBe(0o700);
    }
  });

  it('deletes one remote and leaves the others', () => {
    const path = join(dir, 'credentials');
    const store = fileStore(path);
    store.write('a', { token: '1' });
    store.write('b', { token: '2' });
    store.delete('a');
    expect(store.read('a')).toBeUndefined();
    expect(store.read('b')).toEqual({ token: '2' });
    store.delete('b');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    store.delete('never-there'); // a no-op, not an error
  });

  it('treats a corrupt file as empty rather than crashing every command', () => {
    const path = join(dir, 'credentials');
    const store = fileStore(path);
    store.write('a', { token: '1' });
    rmSync(path);
    expect(store.read('a')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });
});

describe('keychainStore', () => {
  // A fake `security`: an in-memory map keyed by account, answering the
  // three subcommands the store uses and nothing else.
  function fakeSecurity() {
    const items = new Map<string, string>();
    const calls: string[][] = [];
    const run: SecurityRunner = (args) => {
      calls.push(args);
      const account = args[args.indexOf('-a') + 1]!;
      switch (args[0]) {
        case 'find-generic-password': {
          const secret = items.get(account);
          return secret === undefined ? undefined : `${secret}\n`;
        }
        case 'add-generic-password':
          items.set(account, args[args.indexOf('-w') + 1]!);
          return '';
        case 'delete-generic-password':
          return items.delete(account) ? '' : undefined;
        default:
          return undefined;
      }
    };
    return { items, calls, run };
  }

  it('stores under the field service with the remote as the account', () => {
    const { calls, run } = fakeSecurity();
    const store = keychainStore(run);
    store.write('https://audiofield.io', { token: 'tok' });
    expect(calls[0]).toEqual(
      expect.arrayContaining(['add-generic-password', '-a', 'https://audiofield.io', '-s', 'field', '-w', 'tok', '-U']),
    );
    expect(store.read('https://audiofield.io')).toEqual({ token: 'tok' });
    store.delete('https://audiofield.io');
    expect(store.read('https://audiofield.io')).toBeUndefined();
  });

  it('reads a missing item as not logged in, not as an error', () => {
    // `security` exits 44 for "no such item"; the runner maps any
    // non-zero exit to undefined and the store says "no token".
    const store = keychainStore(() => undefined);
    expect(store.read('https://audiofield.io')).toBeUndefined();
  });

  it('reports a failed write rather than pretending the token was stored', () => {
    const store = keychainStore((args) => (args[0] === 'add-generic-password' ? undefined : ''));
    expect(() => store.write('r', { token: 't' })).toThrow('keychain');
  });
});

describe('resolveToken', () => {
  it('lets FIELD_TOKEN override the store and says so', () => {
    const store = fileStore(join(dir, 'c'));
    store.write('https://audiofield.io', { token: 'stored' });
    expect(resolveToken('https://audiofield.io', store, { FIELD_TOKEN: 'env' })).toEqual({
      token: 'env',
      source: 'FIELD_TOKEN',
    });
    expect(resolveToken('https://audiofield.io', store, {})).toEqual({ token: 'stored', source: 'file' });
    expect(resolveToken('https://audiofield.io', store, { FIELD_TOKEN: '' })).toEqual({
      token: 'stored',
      source: 'file',
    });
    expect(resolveToken('https://elsewhere', store, {})).toBeUndefined();
  });
});
