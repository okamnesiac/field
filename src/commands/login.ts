import { spawn } from 'node:child_process';
import { RemoteClient } from '../remote/client.js';
import { resolveToken, type CredentialStore } from '../remote/credentials.js';
import { parseCloneUrl, resolveProjectRemote } from '../remote/origin.js';
import { DEFAULT_REMOTE, GIT_CREDENTIAL_USERNAME } from '../remote/protocol.js';
import { findProjectRoot } from '../model/project.js';

// `field login` and `field logout` (remote.md §3.1): the device-code
// flow, a token stored per remote, and its removal. No password ever
// enters the terminal — the CLI prints a URL and a short code, the
// person approves in a browser, and the poll returns a token.

export interface LoginDeps {
  client: RemoteClient;
  store: CredentialStore;
  out: (line: string) => void;
  // Injected so a test runs the flow in milliseconds with no browser.
  openBrowser?: ((url: string) => void) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export async function login(remote: string, deps: LoginDeps): Promise<{ login?: string | undefined }> {
  const code = await deps.client.deviceCode();
  deps.out(`Open ${code.verification_uri} and enter the code: ${code.user_code}`);
  (deps.openBrowser ?? openBrowser)(code.verification_uri_complete ?? code.verification_uri);
  deps.out('waiting for approval in the browser…');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + code.expires_in * 1000;
  // RFC 8628 §3.5: poll at `interval`, and add five seconds each time
  // the server says slow_down.
  let interval = code.interval;
  while (now() < deadline) {
    await sleep(interval * 1000);
    const answer = await deps.client.deviceToken(code.device_code);
    if ('access_token' in answer) {
      deps.store.write(remote, { token: answer.access_token });
      const env = deps.env ?? process.env;
      if (env['FIELD_TOKEN']) {
        deps.out('note: FIELD_TOKEN is set in this shell and takes precedence over the stored token');
      }
      return { login: answer.login };
    }
    switch (answer.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'access_denied':
        throw new Error('login was denied in the browser');
      case 'expired_token':
        throw new Error('the code expired before it was approved — run field login again');
    }
  }
  throw new Error('the code expired before it was approved — run field login again');
}

export interface LogoutDeps {
  store: CredentialStore;
  // A client carrying the stored token, for the revoke call.
  client: (token: string) => RemoteClient;
  out: (line: string) => void;
  env?: NodeJS.ProcessEnv | undefined;
}

// Forgets the token locally whether or not the remote could be told:
// a logout that fails because the network is down would leave a token
// on disk that the person asked to be rid of.
export async function logout(remote: string, deps: LogoutDeps): Promise<{ forgot: boolean; revoked: boolean }> {
  const env = deps.env ?? process.env;
  if (env['FIELD_TOKEN']) {
    deps.out('note: FIELD_TOKEN is set in this shell; logout cannot unset an environment variable');
  }
  const stored = deps.store.read(remote);
  if (stored === undefined) {
    deps.out(`not logged in to ${remote}`);
    return { forgot: false, revoked: false };
  }
  let revoked = false;
  try {
    await deps.client(stored.token).revoke();
    revoked = true;
  } catch (err) {
    deps.out(`could not revoke the token on ${remote} (${(err as Error).message}); forgetting it locally`);
  }
  deps.store.delete(remote);
  deps.out(`logged out of ${remote}`);
  return { forgot: true, revoked };
}

// Which remote `login`/`logout` mean when no `--remote` is given: the
// project's, when run inside a project that has one; otherwise
// `FIELD_REMOTE`; otherwise the site. Never `off` — logging in to "off"
// is not a thing, so that value falls through to the default.
export function remoteForLogin(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string {
  if (explicit !== undefined && explicit !== '') return explicit.replace(/\/+$/, '');
  const root = findProjectRoot(cwd);
  if (root !== undefined) {
    const resolution = resolveProjectRemote(root, env);
    if (resolution.kind === 'remote') return resolution.remote.api;
  }
  const override = env['FIELD_REMOTE'];
  if (override !== undefined && override !== '' && override !== 'off') return override.replace(/\/+$/, '');
  return DEFAULT_REMOTE;
}

// Git's credential-helper protocol (gitcredentials(7)): `key=value` lines
// on stdin, a blank line ends them, and `get` answers in the same shape.
// `field clone` configures `!field git-credential` as the helper for the
// git host, so Git over HTTPS and the API use the same token without a
// second copy of it anywhere. Only `get` answers; `store` and `erase`
// are Git offering to manage a credential this tool already manages.
export function gitCredentialGet(
  input: string,
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const attrs = new Map<string, string>();
  for (const line of input.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) attrs.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const protocol = attrs.get('protocol');
  const host = attrs.get('host');
  if (protocol === undefined || host === undefined) return undefined;
  // The git host implies the API host (origin.ts), and the token is
  // filed under the API host.
  const api = parseCloneUrl(`${protocol}://${host}/x/y`).api;
  const override = env['FIELD_REMOTE'];
  const candidates = [
    ...(api !== undefined ? [api] : []),
    ...(override !== undefined && override !== '' && override !== 'off' ? [override.replace(/\/+$/, '')] : []),
  ];
  for (const remote of candidates) {
    const found = resolveToken(remote, store, env);
    if (found) return `username=${GIT_CREDENTIAL_USERNAME}\npassword=${found.token}\n`;
  }
  return undefined;
}

function openBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (opener === undefined) return;
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // no browser is fine; the URL was printed
    child.unref();
  } catch {
    // same
  }
}
