import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../git.js';
import { RemoteClient } from '../remote/client.js';
import { fileStore } from '../remote/credentials.js';
import { DEFAULT_REMOTE } from '../remote/protocol.js';
import { fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import { gitCredentialGet, login, logout, remoteForLogin } from './login.js';
import { init } from './init.js';

// The device flow end to end against the stub, with no browser and no
// real clock; the token lands in an injected store and never in the
// output.

let dir: string;
const remotes: FakeRemote[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'field-login-'));
});
afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.close()));
  rmSync(dir, { recursive: true, force: true });
});
async function remote(options: Parameters<typeof fakeRemote>[0] = {}) {
  const r = await fakeRemote(options);
  remotes.push(r);
  return r;
}

function harness(r: FakeRemote) {
  const out: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  return {
    out,
    opened,
    store: fileStore(join(dir, 'credentials')),
    deps: {
      client: new RemoteClient(r.url),
      store: fileStore(join(dir, 'credentials')),
      out: (line: string) => out.push(line),
      openBrowser: (url: string) => opened.push(url),
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      env: {},
    },
  };
}

describe('login', () => {
  it('prints the URL and code, polls, stores the token, and never prints it', async () => {
    const r = await remote({ deviceAnswers: ['authorization_pending', 'slow_down', 'token'], login: 'howlo' });
    const h = harness(r);
    const result = await login(r.url, h.deps);
    expect(result.login).toBe('howlo');
    expect(h.out[0]).toContain(r.userCode);
    expect(h.out[0]).toContain(`${r.url}/device`);
    expect(h.opened).toEqual([`${r.url}/device?code=${r.userCode}`]);
    expect(h.store.read(r.url)).toEqual({ token: r.token });
    expect(h.out.join('\n')).not.toContain(r.token);
    // Three polls: pending, slow_down, token.
    expect(r.requests.filter((q) => q.path === '/api/device/token')).toHaveLength(3);
  });

  it('stops when the person denies, or when the code expires', async () => {
    const denied = await remote({ deviceAnswers: ['access_denied'] });
    await expect(login(denied.url, harness(denied).deps)).rejects.toThrow('denied');
    const expired = await remote({ deviceAnswers: ['expired_token'] });
    await expect(login(expired.url, harness(expired).deps)).rejects.toThrow('expired');
    // ...and on its own clock when the server keeps saying pending past
    // expires_in (600 s from the stub, polled every second).
    const forever = await remote({ deviceAnswers: ['authorization_pending'] });
    const h = harness(forever);
    await expect(login(forever.url, h.deps)).rejects.toThrow('expired');
    expect(h.store.read(forever.url)).toBeUndefined();
  });

  it('notes that FIELD_TOKEN will shadow the token it just stored', async () => {
    const r = await remote();
    const h = harness(r);
    await login(r.url, { ...h.deps, env: { FIELD_TOKEN: 'ci' } });
    expect(h.out.at(-1)).toContain('FIELD_TOKEN');
  });
});

describe('logout', () => {
  it('revokes on the remote and forgets locally', async () => {
    const r = await remote();
    const store = fileStore(join(dir, 'credentials'));
    store.write(r.url, { token: r.token });
    const out: string[] = [];
    const result = await logout(r.url, {
      store,
      client: (token) => new RemoteClient(r.url, { token }),
      out: (l) => out.push(l),
      env: {},
    });
    expect(result).toEqual({ forgot: true, revoked: true });
    expect(r.revoked).toEqual([r.token]);
    expect(store.read(r.url)).toBeUndefined();
  });

  it('forgets locally even when the remote cannot be told', async () => {
    // The person asked to be rid of the token; a network error must not
    // leave it on disk.
    const r = await remote();
    const store = fileStore(join(dir, 'credentials'));
    store.write(r.url, { token: 'not-a-token-the-remote-knows' });
    const out: string[] = [];
    const result = await logout(r.url, {
      store,
      client: (token) => new RemoteClient(r.url, { token }),
      out: (l) => out.push(l),
      env: {},
    });
    expect(result).toEqual({ forgot: true, revoked: false });
    expect(store.read(r.url)).toBeUndefined();
    expect(out.join('\n')).toContain('forgetting it locally');
  });

  it('says so when there was nothing to forget', async () => {
    const r = await remote();
    const out: string[] = [];
    const result = await logout(r.url, {
      store: fileStore(join(dir, 'credentials')),
      client: (token) => new RemoteClient(r.url, { token }),
      out: (l) => out.push(l),
      env: {},
    });
    expect(result).toEqual({ forgot: false, revoked: false });
    expect(out).toEqual([`not logged in to ${r.url}`]);
    expect(r.revoked).toEqual([]);
  });
});

describe('remoteForLogin', () => {
  it("prefers --remote, then the project's origin, then FIELD_REMOTE, then the site", () => {
    expect(remoteForLogin(dir, {}, 'https://staging.audiofield.io/')).toBe('https://staging.audiofield.io');
    expect(remoteForLogin(dir, {})).toBe(DEFAULT_REMOTE);
    expect(remoteForLogin(dir, { FIELD_REMOTE: 'http://127.0.0.1:9' })).toBe('http://127.0.0.1:9');
    expect(remoteForLogin(dir, { FIELD_REMOTE: 'off' })).toBe(DEFAULT_REMOTE);
    init({ dir, name: 'chemicals' });
    git(['remote', 'add', 'origin', 'https://git.audiofield.io/howlo/chemicals.git'], { cwd: dir });
    expect(remoteForLogin(join(dir, 'songs'), {})).toBe('https://audiofield.io');
  });
});

describe('gitCredentialGet', () => {
  it('answers Git for the git host with the token filed under the API host', () => {
    const store = fileStore(join(dir, 'credentials'));
    store.write('https://audiofield.io', { token: 'tok' });
    const answer = gitCredentialGet('protocol=https\nhost=git.audiofield.io\npath=howlo/chemicals.git\n\n', store, {});
    expect(answer).toBe('username=field\npassword=tok\n');
  });

  it('stays silent for hosts it holds nothing for, so Git falls through to its own helpers', () => {
    const store = fileStore(join(dir, 'credentials'));
    store.write('https://audiofield.io', { token: 'tok' });
    expect(gitCredentialGet('protocol=https\nhost=github.com\n\n', store, {})).toBeUndefined();
    expect(gitCredentialGet('protocol=https\nhost=git.elsewhere.io\n\n', store, {})).toBeUndefined();
    expect(gitCredentialGet('garbage\n', store, {})).toBeUndefined();
  });

  it('honours FIELD_TOKEN and FIELD_REMOTE', () => {
    const store = fileStore(join(dir, 'credentials'));
    expect(gitCredentialGet('protocol=https\nhost=git.audiofield.io\n\n', store, { FIELD_TOKEN: 'ci' })).toBe(
      'username=field\npassword=ci\n',
    );
    store.write('http://127.0.0.1:9', { token: 'stub' });
    expect(
      gitCredentialGet('protocol=http\nhost=127.0.0.1:9\n\n', store, { FIELD_REMOTE: 'http://127.0.0.1:9' }),
    ).toBe('username=field\npassword=stub\n');
  });
});
