import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CREDENTIAL_SERVICE, CREDENTIALS_FILE } from './protocol.js';

// Where a token lives (remote.md §5 decision 5): the macOS keychain
// through `security`, and `~/.field/credentials` (mode 0600) elsewhere.
// Field's pattern for platform services is to shell out — afplay, git,
// sclang — and `security add-generic-password` is that pattern applied
// to secrets, with no dependency added. Linux has no single keyring a
// runner image is guaranteed to have, so a file under a home directory
// Field is about to own anyway is the honest fallback. This is Field's
// first per-user state; docs/remote.md says where it is and what
// deletes it.
//
// One token per remote, keyed by the API base URL, so a staging site
// and the real one can both be logged in at once.

export interface Credential {
  token: string;
}

export interface CredentialStore {
  readonly kind: 'keychain' | 'file';
  read(remote: string): Credential | undefined;
  write(remote: string, credential: Credential): void;
  delete(remote: string): void;
}

// `security`'s interface, injected so tests never touch the real
// keychain (remote.md §7). Returns stdout on success, undefined on any
// non-zero exit — `find-generic-password` exits 44 for "no such item",
// which is a miss rather than an error.
export type SecurityRunner = (args: string[]) => string | undefined;

export const runSecurity: SecurityRunner = (args) => {
  const r = spawnSync('security', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : undefined;
};

export function keychainStore(run: SecurityRunner = runSecurity): CredentialStore {
  const item = (remote: string) => ['-a', remote, '-s', CREDENTIAL_SERVICE];
  return {
    kind: 'keychain',
    read(remote) {
      const out = run(['find-generic-password', ...item(remote), '-w']);
      if (out === undefined) return undefined;
      const token = out.trim();
      return token ? { token } : undefined;
    },
    write(remote, credential) {
      // `-U` updates in place when the item exists, so a second login
      // replaces the token rather than failing on a duplicate. The
      // secret rides argv, which `ps` can see for the instant the call
      // takes; `security` offers no stdin form, and a native keychain
      // binding was the dependency decision 5 declined.
      const out = run([
        'add-generic-password',
        ...item(remote),
        '-l',
        `${CREDENTIAL_SERVICE}: ${remote}`,
        '-w',
        credential.token,
        '-U',
      ]);
      if (out === undefined) throw new Error('could not store the token in the keychain (security add-generic-password failed)');
    },
    delete(remote) {
      run(['delete-generic-password', ...item(remote)]);
    },
  };
}

// The file fallback: a JSON map from remote to credential, mode 0600 in
// a 0700 directory, written tmp + rename so a crash leaves the old file
// or the new one and never a truncated one.
export function fileStore(path: string = defaultCredentialsPath()): CredentialStore {
  type Contents = Record<string, Credential>;
  const load = (): Contents => {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return parsed !== null && typeof parsed === 'object' ? (parsed as Contents) : {};
    } catch {
      return {};
    }
  };
  const save = (contents: Contents) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(contents, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600); // writeFileSync's mode is masked by umask
    renameSync(tmp, path);
  };
  return {
    kind: 'file',
    read(remote) {
      const entry = load()[remote];
      return entry && typeof entry.token === 'string' && entry.token ? { token: entry.token } : undefined;
    },
    write(remote, credential) {
      save({ ...load(), [remote]: credential });
    },
    delete(remote) {
      const contents = load();
      if (!(remote in contents)) return;
      delete contents[remote];
      save(contents);
    },
  };
}

export function defaultCredentialsPath(): string {
  return join(homedir(), ...CREDENTIALS_FILE);
}

export function defaultCredentialStore(platform: NodeJS.Platform = process.platform): CredentialStore {
  return platform === 'darwin' ? keychainStore() : fileStore();
}

// The token a call should carry, and where it came from. `FIELD_TOKEN`
// overrides stored credentials for CI and agents and is never written
// anywhere (remote.md §3.1); the store answers otherwise.
export type TokenSource = 'FIELD_TOKEN' | 'keychain' | 'file';

export function resolveToken(
  remote: string,
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): { token: string; source: TokenSource } | undefined {
  const fromEnv = env['FIELD_TOKEN'];
  if (fromEnv !== undefined && fromEnv !== '') return { token: fromEnv, source: 'FIELD_TOKEN' };
  const stored = store.read(remote);
  return stored ? { token: stored.token, source: store.kind } : undefined;
}
