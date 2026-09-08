import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { packageVersion } from '../packageVersion.js';
import {
  REMOTE_API_VERSION,
  artifactEntrySchema,
  deviceCodeResponseSchema,
  deviceTokenResponseSchema,
  helloResponseSchema,
  missingResponseSchema,
  paths,
  projectResponseSchema,
  type DeviceCode,
  type DeviceTokenResponse,
  type RemoteArtifactEntry,
  type RemoteHello,
  type RemoteProject,
} from './protocol.js';

// The HTTP client for an audiofield remote, over Node's global fetch —
// no dependency added (project-core.md §5 prefers the boring answer, and
// remote.md §2 records that this is where it was decided). Every method
// is one request; the policy about what a failure means for a build
// lives in cache.ts, and the verbs live in commands/.

export type RemoteErrorKind =
  | 'unreachable' // the connection failed: DNS, refused, reset, timed out
  | 'refused' // 401 or 403: the token was rejected or missing
  | 'protocol' // the remote speaks a different protocol, or not ours at all
  | 'http'; // any other non-2xx answer

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

export interface RemoteClientOptions {
  token?: string | undefined;
  // Injected for tests: an in-process stub's fetch, or one that throws.
  fetch?: typeof fetch;
}

// Every conversation is HTTPS (remote.md §4), and this is where that is
// enforced rather than assumed: a token crosses the network on the
// first authenticated call, and the device-code exchange hands one back
// over the same connection, so a cleartext base is refused before either
// happens. Plain `http` is accepted only for a loopback host, which is
// how anyone runs the CLI against a site on their own machine and how
// the tests reach their in-process stub. Whichever route produced the
// URL — an origin, `FIELD_REMOTE`, `--remote` — lands here (minjudd on
// #171: the origin route accepted `http://git.example.com` and would
// have sent the bearer in the clear).
export function cleartextReason(base: string): string | undefined {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `${base} is not a URL`;
  }
  if (url.protocol === 'https:') return undefined;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return undefined;
  return (
    `refusing to send a token in the clear to ${base} — a remote must be https ` +
    `(plain http is allowed only for localhost)`
  );
}

function isLoopbackHost(hostname: string): boolean {
  // URL brackets IPv6 hostnames: `http://[::1]:3000` reads back as `[::1]`.
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export class RemoteClient {
  readonly base: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private helloPromise: Promise<RemoteHello> | undefined;

  constructor(base: string, options: RemoteClientOptions = {}) {
    this.base = base.replace(/\/+$/, '');
    const cleartext = cleartextReason(this.base);
    if (cleartext !== undefined) throw new RemoteError('protocol', cleartext);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  // Checked once per client, before the first real call. A `protocol`
  // other than ours gets the daemon treatment (audiod/client.ts:152):
  // stop, and say which side to update. A site that does not answer
  // `/api/hello` at all is not an audiofield remote, which is a
  // protocol error too — the request was fine and the answer was not.
  hello(): Promise<RemoteHello> {
    this.helloPromise ??= (async () => {
      const res = await this.request('GET', paths.hello, undefined, { auth: false });
      if (res.status === 404) {
        throw new RemoteError('protocol', `${this.base} is not an audiofield remote (no /api/hello)`, 404);
      }
      const hello = await this.parse(res, helloResponseSchema, 'hello');
      if (hello.protocol !== REMOTE_API_VERSION) {
        const side = hello.protocol > REMOTE_API_VERSION ? 'update field' : 'the site needs updating';
        throw new RemoteError(
          'protocol',
          `${this.base} speaks protocol ${hello.protocol}, this CLI speaks ${REMOTE_API_VERSION} — ${side}`,
        );
      }
      return hello;
    })();
    return this.helloPromise;
  }

  // Capability gate by name, never by arithmetic on `version`.
  async supports(feature: string): Promise<boolean> {
    return (await this.hello()).features.includes(feature);
  }

  // --- device authorization (RFC 8628) ---

  async deviceCode(): Promise<DeviceCode> {
    await this.hello();
    const res = await this.request('POST', paths.deviceCode, {}, { auth: false });
    return this.parse(res, deviceCodeResponseSchema, 'device code');
  }

  // One poll. The RFC puts the pending/slow_down answers behind a 400,
  // so the body is read whatever the status says; the schema decides.
  async deviceToken(deviceCode: string): Promise<DeviceTokenResponse> {
    const res = await this.request('POST', paths.deviceToken, { device_code: deviceCode }, { auth: false });
    if (res.ok || res.status === 400) return this.parse(res, deviceTokenResponseSchema, 'token');
    throw await this.httpError(res, 'token');
  }

  // Forget the token on the remote too. Best effort by the caller's
  // choice: logout deletes locally whether or not this succeeds.
  async revoke(): Promise<void> {
    await this.hello();
    const res = await this.request('DELETE', paths.revoke);
    if (!res.ok && res.status !== 404) throw await this.httpError(res, 'revoke');
  }

  // --- projects and artifacts ---

  // `undefined` for a 404, which is also what a private project the
  // token cannot see answers (audiofield-io.md §9.9).
  async resolveProject(owner: string, project: string): Promise<RemoteProject | undefined> {
    await this.hello();
    const res = await this.request('GET', paths.project(owner, project));
    if (res.status === 404) return undefined;
    return this.parse(res, projectResponseSchema, 'project');
  }

  async missing(owner: string, project: string, actionKeys: string[]): Promise<string[]> {
    await this.hello();
    const res = await this.request('POST', paths.missing(owner, project), { action_keys: actionKeys });
    return (await this.parse(res, missingResponseSchema, 'missing')).missing;
  }

  async fetchEntry(owner: string, project: string, actionKey: string): Promise<RemoteArtifactEntry | undefined> {
    await this.hello();
    const res = await this.request('GET', paths.artifact(owner, project, actionKey));
    if (res.status === 404) return undefined;
    return this.parse(res, artifactEntrySchema, 'artifact');
  }

  // Streams a presigned URL to `toPath`, hashing on the way, and reports
  // what actually arrived. The caller compares against the entry — the
  // check belongs on the fetch path, not inside materialize() (remote.md
  // §2) — and never lets a disagreeing file reach the CAS.
  async download(url: string, toPath: string): Promise<{ sha256: string; bytes: number }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { 'user-agent': userAgent() } });
    } catch (err) {
      throw new RemoteError('unreachable', `download failed: ${(err as Error).message}`);
    }
    if (!res.ok || res.body === null) {
      throw new RemoteError('http', `download of ${url} answered ${res.status}`, res.status);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    source.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(source, createWriteStream(toPath));
    return { sha256: hash.digest('hex'), bytes };
  }

  // --- plumbing ---

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { auth?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': userAgent() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth !== false && this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new RemoteError(
        'unreachable',
        `${this.base} is unreachable${cause ? ` (${cause})` : ''}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new RemoteError(
        'refused',
        this.token === undefined
          ? `${this.base} requires a token (field login)`
          : `${this.base} refused the token (field login again)`,
        res.status,
      );
    }
    return res;
  }

  private async parse<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
    if (!res.ok && res.status !== 400) throw await this.httpError(res, what);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RemoteError('protocol', `${this.base} answered ${what} with something other than JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new RemoteError('protocol', `${this.base} answered ${what} in a shape this CLI does not know`);
    }
    return parsed.data;
  }

  private async httpError(res: Response, what: string): Promise<RemoteError> {
    let detail = '';
    try {
      const text = await res.text();
      const json = JSON.parse(text) as { error?: unknown; message?: unknown };
      const msg = json.message ?? json.error;
      if (typeof msg === 'string') detail = `: ${msg}`;
    } catch {
      // the body was not JSON; the status is the message
    }
    return new RemoteError('http', `${this.base} answered ${what} with ${res.status}${detail}`, res.status);
  }
}

function userAgent(): string {
  return `field/${packageVersion()}`;
}
