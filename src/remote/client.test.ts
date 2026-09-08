import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { deadPort, fakeRemote, type FakeRemote } from '../testing/fake-remote.js';
import { RemoteClient, RemoteError } from './client.js';
import { REMOTE_API_VERSION } from './protocol.js';

// The client is one request per method and a hello checked once; what a
// failure means for a build is cache.ts's business. These tests pin the
// error *kinds*, because that is what cache.ts switches on.

const remotes: FakeRemote[] = [];
afterEach(async () => {
  await Promise.all(remotes.splice(0).map((r) => r.close()));
});
async function remote(options: Parameters<typeof fakeRemote>[0] = {}) {
  const r = await fakeRemote(options);
  remotes.push(r);
  return r;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const key = 'a'.repeat(64);

describe('RemoteClient', () => {
  it('refuses a cleartext base before any token can cross it (minjudd on #171)', () => {
    // Every conversation is HTTPS (remote.md §4); plain http only for a
    // loopback host, which is how a site on this machine is reached.
    expect(() => new RemoteClient('http://example.com', { token: 't' })).toThrow(/in the clear.*https/);
    expect(() => new RemoteClient('http://git.example.com:8080')).toThrow(/in the clear/);
    expect(() => new RemoteClient('not a url')).toThrow(/not a URL/);
    for (const ok of ['https://audiofield.io', 'http://localhost:3000', 'http://127.0.0.1:1', 'http://[::1]:1']) {
      expect(new RemoteClient(ok).base).toBe(ok);
    }
  });

  it('says hello once per client and gates on protocol, not version', async () => {
    const r = await remote();
    const client = new RemoteClient(r.url);
    await client.resolveProject('howlo', 'chemicals');
    await client.resolveProject('howlo', 'chemicals');
    expect(r.requests.filter((q) => q.path === '/api/hello')).toHaveLength(1);
    expect(await client.supports('anything')).toBe(false);
  });

  it('refuses a remote speaking another protocol and says which side to update', async () => {
    const newer = await remote({ protocol: REMOTE_API_VERSION + 1 });
    await expect(new RemoteClient(newer.url).resolveProject('h', 'c')).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('update field'),
    });
    const older = await remote({ protocol: REMOTE_API_VERSION - 1 });
    await expect(new RemoteClient(older.url).resolveProject('h', 'c')).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('site needs updating'),
    });
  });

  it('calls a site with no /api/hello not an audiofield remote', async () => {
    const r = await remote({ noHello: true });
    await expect(new RemoteClient(r.url).resolveProject('h', 'c')).rejects.toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('not an audiofield remote'),
    });
  });

  it('reports a dead port as unreachable', async () => {
    const url = await deadPort();
    const err = await new RemoteClient(url).resolveProject('h', 'c').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).kind).toBe('unreachable');
    expect((err as RemoteError).message).toContain('unreachable');
  });

  it('reports a 401 as refused, naming the fix', async () => {
    const r = await remote({ refuseAll: true });
    await expect(new RemoteClient(r.url).resolveProject('h', 'c')).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('field login'),
    });
    await expect(new RemoteClient(r.url, { token: 'stale' }).resolveProject('h', 'c')).rejects.toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('login again'),
    });
  });

  it('sends the bearer token, and a private project is a 404 without it', async () => {
    const r = await remote();
    r.addProject('howlo/secret', {
      clone_url: 'https://git.example/howlo/secret.git',
      default_branch: 'main',
      visibility: 'private',
    });
    expect(await new RemoteClient(r.url).resolveProject('howlo', 'secret')).toBeUndefined();
    const seen = await new RemoteClient(r.url, { token: r.token }).resolveProject('howlo', 'secret');
    expect(seen).toMatchObject({ visibility: 'private', default_branch: 'main' });
    expect(r.requests.at(-1)?.authorization).toBe(`Bearer ${r.token}`);
    // hello itself never carries the token: it is answered to strangers.
    expect(r.requests.find((q) => q.path === '/api/hello')?.authorization).toBeUndefined();
  });

  it('fetches an entry with download URLs and streams a blob to disk, hashed', async () => {
    const r = await remote();
    r.addProject('howlo/chemicals', { clone_url: 'x://y/z', default_branch: 'main', visibility: 'public' });
    const bytes = Buffer.from('pretend this is a wav');
    r.addArtifact('howlo/chemicals', key, { rule: 'stem', outputs: [{ sha256: sha(bytes), bytes: bytes.length }] }, [bytes]);
    const client = new RemoteClient(r.url);
    expect(await client.fetchEntry('howlo', 'chemicals', 'b'.repeat(64))).toBeUndefined();
    const entry = await client.fetchEntry('howlo', 'chemicals', key);
    expect(entry).toMatchObject({ rule: 'stem', outputs: [{ sha256: sha(bytes), bytes: bytes.length }] });
    expect(await client.missing('howlo', 'chemicals', [key, 'b'.repeat(64)])).toEqual(['b'.repeat(64)]);

    const dir = mkdtempSync(join(tmpdir(), 'field-client-'));
    try {
      const got = await client.download(entry!.outputs[0]!.url, join(dir, 'blob'));
      expect(got).toEqual({ sha256: sha(bytes), bytes: bytes.length });
      expect(readFileSync(join(dir, 'blob'))).toEqual(bytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the device flow: a code, then polls until the token arrives', async () => {
    const r = await remote({ deviceAnswers: ['authorization_pending', 'slow_down', 'token'], login: 'howlo' });
    const client = new RemoteClient(r.url);
    const code = await client.deviceCode();
    expect(code.user_code).toBe(r.userCode);
    expect(code.interval).toBe(1);
    expect(await client.deviceToken(code.device_code)).toEqual({ error: 'authorization_pending' });
    expect(await client.deviceToken(code.device_code)).toEqual({ error: 'slow_down' });
    expect(await client.deviceToken(code.device_code)).toEqual({
      access_token: r.token,
      token_type: 'bearer',
      login: 'howlo',
    });
    await new RemoteClient(r.url, { token: r.token }).revoke();
    expect(r.revoked).toEqual([r.token]);
  });
});
