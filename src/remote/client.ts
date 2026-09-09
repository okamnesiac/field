import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
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
  offerResponseSchema,
  paths,
  projectResponseSchema,
  type DeviceCode,
  type DeviceTokenResponse,
  type OfferRequest,
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
  timeouts?: Partial<RemoteTimeouts> | undefined;
}

// How long a black-holed remote may hold a build before it counts as
// unreachable and the once-only notice prints (audiofield on #171:
// undici's own default is about five minutes). API answers are small
// JSON, so a flat deadline; a download is bounded per chunk instead,
// because a large artifact on a slow link is not a stall.
export interface RemoteTimeouts {
  request: number; // ms, whole request
  idle: number; // ms between chunks of a download
}
export const DEFAULT_TIMEOUTS: RemoteTimeouts = { request: 15_000, idle: 30_000 };

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
  private readonly timeouts: RemoteTimeouts;
  private helloPromise: Promise<RemoteHello> | undefined;

  constructor(base: string, options: RemoteClientOptions = {}) {
    this.base = base.replace(/\/+$/, '');
    const cleartext = cleartextReason(this.base);
    if (cleartext !== undefined) throw new RemoteError('protocol', cleartext);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
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
    return this.parse(res, deviceTokenResponseSchema, 'token', { allow400: true });
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

  // --- the offer (remote.md §3.3) ---

  // Announce an entry and the commit and label it satisfies. The answer
  // names the outputs the remote lacks, each with a presigned URL to PUT
  // the bytes to; an empty list means every output is already held.
  async offer(owner: string, project: string, entry: OfferRequest): Promise<{ sha256: string; url: string }[]> {
    await this.hello();
    const res = await this.request('POST', paths.offer(owner, project), entry);
    return (await this.parse(res, offerResponseSchema, 'offer')).uploads;
  }

  // PUT one output's bytes to the URL the offer handed out. The URL is
  // presigned, so no token rides with it; the remote hashes what lands
  // at completion, and a mismatch there is refused, never registered.
  // Streamed from disk, never buffered, under the same idle timer the
  // download has: a render is the largest thing this CLI moves and a
  // slow uplink is not a stall (minjudd on #172). The length goes in the
  // header so the bucket sees one sized PUT rather than a chunked body.
  async upload(url: string, fromPath: string): Promise<void> {
    const idle = this.idleGuard(`upload to ${hostOf(url)}`);
    let res: Response;
    try {
      const source = createReadStream(fromPath);
      source.on('data', () => idle.arm());
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(statSync(fromPath).size),
          'user-agent': userAgent(),
        },
        body: Readable.toWeb(source) as ReadableStream,
        duplex: 'half',
        signal: idle.signal,
      } as RequestInit);
    } catch (err) {
      if (idle.signal.aborted) throw idle.signal.reason as RemoteError;
      throw new RemoteError('unreachable', `upload to ${hostOf(url)} failed: ${(err as Error).message}`);
    } finally {
      idle.clear();
    }
    if (!res.ok) throw new RemoteError('http', `upload to ${hostOf(url)} answered ${res.status}`, res.status);
  }

  // The uploads of an offer have landed: verify them and register the
  // entry. A completion the remote refuses — bytes that hash to something
  // else, an upload that never arrived — is an `http` error carrying the
  // remote's own message, and the entry does not exist there.
  async complete(owner: string, project: string, actionKey: string): Promise<void> {
    await this.hello();
    const res = await this.request('POST', paths.complete(owner, project, actionKey), {});
    if (!res.ok) throw await this.httpError(res, 'completion');
  }

  // Streams a presigned URL to `toPath`, hashing on the way, and reports
  // what actually arrived. The caller compares against the entry — the
  // check belongs on the fetch path, not inside materialize() (remote.md
  // §2) — and never lets a disagreeing file reach the CAS.
  async download(url: string, toPath: string): Promise<{ sha256: string; bytes: number }> {
    const idle = this.idleGuard(`download from ${hostOf(url)}`);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': userAgent() }, signal: idle.signal });
      if (!res.ok || res.body === null) {
        throw new RemoteError('http', `download of ${url} answered ${res.status}`, res.status);
      }
      const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      source.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
        idle.arm();
      });
      await pipeline(source, createWriteStream(toPath));
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      if (idle.signal.aborted) throw idle.signal.reason as RemoteError;
      throw new RemoteError('unreachable', `download failed: ${(err as Error).message}`);
    } finally {
      idle.clear();
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  // Idle, not total: a timer that re-arms on every chunk, so a slow link
  // is fine and a stalled one is not, and a large artifact is bounded by
  // the gaps in its transfer rather than its size. Armed on creation, so
  // a transfer that never starts is a stall too.
  private idleGuard(what: string): { signal: AbortSignal; arm: () => void; clear: () => void } {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new RemoteError('unreachable', `${what} went idle for ${this.timeouts.idle / 1000}s`)),
        this.timeouts.idle,
      );
    };
    arm();
    return {
      signal: controller.signal,
      arm,
      clear: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
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
    const signal = AbortSignal.timeout(this.timeouts.request);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        signal,
        // Never follow: an API that redirects is misconfigured — the
        // apex sending every path to a marketing site was the live case
        // — and following would talk to whatever it points at instead
        // of saying so.
        redirect: 'manual',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (signal.aborted) {
        throw new RemoteError(
          'unreachable',
          `${this.base} did not answer within ${this.timeouts.request / 1000}s`,
        );
      }
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new RemoteError(
        'unreachable',
        `${this.base} is unreachable${cause ? ` (${cause})` : ''}`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? 'elsewhere';
      throw new RemoteError(
        'protocol',
        `${this.base} redirects ${path} to ${location} — the API must be served directly`,
        res.status,
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

  // A 400 is an error with a message worth reading, except on the token
  // poll, where RFC 8628 puts the pending and slow-down answers behind
  // one; parsing every 400 against the success schema hid the server's
  // message behind "a shape this CLI does not know" (audiofield on #171).
  private async parse<T>(
    res: Response,
    schema: z.ZodType<T>,
    what: string,
    options: { allow400?: boolean } = {},
  ): Promise<T> {
    if (!res.ok && !(options.allow400 === true && res.status === 400)) throw await this.httpError(res, what);
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
