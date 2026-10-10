import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { REMOTE_API_VERSION } from '../remote/protocol.js';

// An in-process audiofield remote for tests (remote.md §7): a node:http
// server on an ephemeral port holding action entries and blobs in memory,
// its base URL handed to the client as `FIELD_REMOTE`. Every route the
// CLI speaks is here and nothing else, so a fetch, a hash mismatch, a
// 404, a refused token, a protocol skew, and a dead port each have a
// test and none touch the network. fakeDaemon() in version.test.ts is
// the pattern it follows.

export interface FakeArtifact {
  rule: string;
  outputs: { sha256: string; bytes: number }[];
}

export interface FakeProject {
  clone_url: string;
  default_branch: string;
  visibility: 'public' | 'private';
  artifacts: Map<string, FakeArtifact>; // by action key
  // What a push registers beside the entries (audiofield-io.md §5.7): the
  // commit and label each entry satisfies, keyed "<commit> <label>".
  refs: Map<string, string>;
  // Offers whose completion has not come; served by nothing until then.
  offers: Map<string, FakeArtifact & { commit: string; label: string }>;
}

export interface FakeRequest {
  method: string;
  path: string;
  authorization?: string | undefined;
}

export interface FakeRemoteOptions {
  protocol?: number | undefined; // what hello claims; default ours
  // The token poll's answers, in order; 'token' ends it. Default: one
  // pending answer, then the token.
  deviceAnswers?: ('authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'token')[] | undefined;
  login?: string | undefined;
  refuseAll?: boolean | undefined; // 401 on every route but hello
  noHello?: boolean | undefined; // 404 on /api/hello: not an audiofield site
  hang?: boolean | undefined; // never answer anything: the black-holed remote
  stallBlobs?: boolean | undefined; // start every blob and never finish it
  stallUploads?: boolean | undefined; // accept an upload's connection and never read its body
  redirectTo?: string | undefined; // 307 every /api path to another origin
  // Exact-path overrides, checked first: a 400 with a message, say.
  answers?: Record<string, { status: number; body: unknown }> | undefined;
}

export interface FakeRemote {
  url: string;
  requests: FakeRequest[];
  projects: Map<string, FakeProject>; // "owner/project"
  blobs: Map<string, Buffer>; // by sha256
  tokens: Set<string>; // accepted bearer tokens
  revoked: string[];
  readonly token: string; // the token the device flow hands out
  readonly userCode: string;
  addProject(name: string, project: Omit<FakeProject, 'artifacts' | 'refs' | 'offers'>): FakeProject;
  // Registers an entry and its bytes under a project, as the site would
  // hold them after a push.
  addArtifact(project: string, actionKey: string, entry: FakeArtifact, blobs: Buffer[]): void;
  close(): Promise<void>;
}

export async function fakeRemote(options: FakeRemoteOptions = {}): Promise<FakeRemote> {
  const requests: FakeRequest[] = [];
  const projects = new Map<string, FakeProject>();
  const blobs = new Map<string, Buffer>();
  const staged = new Map<string, Buffer>(); // uploads a completion has not hashed yet
  const token = 'fake-token-' + Math.random().toString(36).slice(2);
  const tokens = new Set<string>([token]);
  const revoked: string[] = [];
  const deviceCode = 'device-' + Math.random().toString(36).slice(2);
  const userCode = 'WDJB-MJHT';
  const answers = [...(options.deviceAnswers ?? ['authorization_pending', 'token'])];

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const bearer = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization;
    return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  };
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : undefined);
      });
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname, authorization: req.headers.authorization });
    const auth = bearer(req);
    const authorized = auth !== undefined && tokens.has(auth);

    if (options.hang) return; // the socket stays open and silent
    const override = options.answers?.[url.pathname];
    if (override !== undefined) return json(res, override.status, override.body);
    if (options.redirectTo !== undefined && url.pathname.startsWith('/api/')) {
      res.writeHead(307, { location: `${options.redirectTo}${url.pathname}` });
      return res.end();
    }

    if (url.pathname === '/api/hello') {
      if (options.noHello) return json(res, 404, { error: 'not found' });
      return json(res, 200, {
        protocol: options.protocol ?? REMOTE_API_VERSION,
        version: '0.0.0-fake',
        features: [],
      });
    }
    if (options.refuseAll) return json(res, 401, { error: 'unauthorized' });

    if (url.pathname === '/api/device/code' && method === 'POST') {
      return json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?code=${userCode}`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (url.pathname === '/api/device/token' && method === 'POST') {
      const body = (await readBody(req)) as { device_code?: string } | undefined;
      if (body?.device_code !== deviceCode) return json(res, 400, { error: 'access_denied' });
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next === 'token') {
        return json(res, 200, {
          access_token: token,
          token_type: 'bearer',
          ...(options.login !== undefined ? { login: options.login } : {}),
        });
      }
      return json(res, 400, { error: next });
    }
    if (url.pathname === '/api/token' && method === 'DELETE') {
      if (!authorized) return json(res, 401, { error: 'unauthorized' });
      tokens.delete(auth!);
      revoked.push(auth!);
      res.writeHead(204);
      return res.end();
    }

    const blob = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname);
    if (blob) {
      const bytes = blobs.get(blob[1]!);
      if (bytes === undefined) return json(res, 404, { error: 'no such blob' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
      if (options.stallBlobs) return void res.write(bytes.subarray(0, 1)); // one byte, then silence
      return res.end(bytes);
    }
    // A presigned upload, as the site's bucket takes one: a PUT of the
    // bytes, no token. Kept apart from verified blobs until a completion
    // hashes it, the way the site stages an upload.
    const upload = /^\/upload\/([0-9a-f]{64})$/.exec(url.pathname);
    if (upload && method === 'PUT') {
      if (options.stallUploads) return; // the body is never read: a stalled uplink
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      staged.set(upload[1]!, Buffer.concat(chunks));
      res.writeHead(200);
      return res.end();
    }

    const m = /^\/api\/projects\/([^/]+)\/([^/]+)(?:\/artifacts(?:\/([^/]+)(?:\/(complete))?)?)?$/.exec(url.pathname);
    if (m) {
      const project = projects.get(`${m[1]}/${m[2]}`);
      // Private and unseen is the same 404 as absent (audiofield-io.md §9.9).
      if (project === undefined || (project.visibility === 'private' && !authorized)) {
        return json(res, 404, { error: 'not found' });
      }
      if (m[3] === undefined && !url.pathname.endsWith('/artifacts')) {
        const { clone_url, default_branch, visibility } = project;
        return json(res, 200, { clone_url, default_branch, visibility });
      }
      // The writes: an offer and its completion need a token that may push.
      if (url.pathname.endsWith('/artifacts') && method === 'POST') {
        if (!authorized) return json(res, 401, { error: 'unauthorized' });
        const body = (await readBody(req)) as {
          commit: string;
          label: string;
          action_key: string;
          rule: string;
          outputs: { sha256: string; bytes: number }[];
        };
        project.offers.set(`${body.action_key} ${body.commit} ${body.label}`, {
          rule: body.rule,
          outputs: body.outputs,
          commit: body.commit,
          label: body.label,
        });
        const uploads = body.outputs
          .filter((o) => !blobs.has(o.sha256))
          .map((o) => ({ sha256: o.sha256, url: `${base}/upload/${o.sha256}` }));
        return json(res, 200, { uploads });
      }
      if (m[4] === 'complete' && method === 'POST') {
        if (!authorized) return json(res, 401, { error: 'unauthorized' });
        const key = m[3]!;
        const pending = [...project.offers.entries()].filter(([id]) => id.startsWith(`${key} `));
        if (pending.length === 0) return json(res, 404, { error: 'no_offer', message: 'nothing was offered under this action key' });
        const entry = pending[pending.length - 1]![1];
        for (const output of entry.outputs) {
          if (blobs.has(output.sha256)) continue;
          const bytes = staged.get(output.sha256);
          if (bytes === undefined) return json(res, 422, { error: 'missing_upload', message: `${output.sha256} was not uploaded` });
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== output.sha256 || bytes.length !== output.bytes) {
            staged.delete(output.sha256);
            return json(res, 422, { error: 'hash_mismatch', message: `the bytes uploaded for ${output.sha256} hash to ${digest}` });
          }
          blobs.set(output.sha256, bytes);
          staged.delete(output.sha256);
        }
        project.artifacts.set(key, { rule: entry.rule, outputs: entry.outputs });
        for (const [id, offer] of pending) {
          project.refs.set(`${offer.commit} ${offer.label}`, key);
          project.offers.delete(id);
        }
        return json(res, 200, { action_key: key, rule: entry.rule, outputs: entry.outputs });
      }
      if (m[3] === 'missing' && method === 'POST') {
        const body = (await readBody(req)) as { action_keys: string[] };
        return json(res, 200, { missing: body.action_keys.filter((k) => !project.artifacts.has(k)) });
      }
      if (m[3] !== undefined && m[4] === undefined && method === 'GET') {
        const entry = project.artifacts.get(m[3]);
        if (entry === undefined) return json(res, 404, { error: 'no such artifact' });
        return json(res, 200, {
          rule: entry.rule,
          outputs: entry.outputs.map((o) => ({ ...o, url: `${base}/blob/${o.sha256}` })),
        });
      }
    }
    json(res, 404, { error: `no route for ${method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake remote did not bind a port');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    url: base,
    requests,
    projects,
    blobs,
    tokens,
    revoked,
    token,
    userCode,
    addProject(name, project) {
      const full: FakeProject = { ...project, artifacts: new Map(), refs: new Map(), offers: new Map() };
      projects.set(name, full);
      return full;
    },
    addArtifact(name, actionKey, entry, bytes) {
      const project = projects.get(name);
      if (project === undefined) throw new Error(`fake remote has no project ${name}`);
      project.artifacts.set(actionKey, entry);
      for (const buffer of bytes) {
        const sha = entry.outputs.find((o) => o.bytes === buffer.length)?.sha256;
        if (sha === undefined) throw new Error('blob does not match any output by size');
        blobs.set(sha, buffer);
      }
    },
    // Connections a hanging or stalled route left open would keep
    // close() from ever calling back; drop them first.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// The port of a server that has already closed: connecting to it is
// refused, which is the "dead port" case (remote.md §7).
export async function deadPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}`;
}
