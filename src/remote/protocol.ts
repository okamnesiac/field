import { z } from 'zod';

// The contract between the CLI and an audiofield remote (remote.md §4).
// The site owns the API; this file is what the CLI needs it to say, as
// zod schemas so the site's tests can import the same shapes and a
// drift fails a test on whichever side moved second (remote.md §7).
// Every conversation is HTTPS and JSON, opened the way the daemons
// open theirs: a hello carrying `protocol`, checked once per process,
// with everything finer a name in `features` (recording.md §2 records
// why capability names beat version arithmetic).

// 1: first contract — device auth, resolve, missing, fetch, offer.
export const REMOTE_API_VERSION = 1;

// Where the API lives when nothing says otherwise: the web host. Git and
// LFS are served from `git.<apex>` (audiofield-io.md §10.9), which is
// why `origin.ts` derives one host from the other rather than storing a
// second URL anywhere.
export const DEFAULT_REMOTE = 'https://audiofield.io';

// The credential's name inside the keychain and the file store, and the
// user-agent the client sends. Subsystem constants live with the
// subsystem (remote.md §2), the way SOCKET_RELATIVE lives in audiod/.
export const CREDENTIAL_SERVICE = 'field';
export const CREDENTIALS_FILE = ['.field', 'credentials'] as const;

// The basic-auth username the credential helper hands Git. The git host
// checks the token sent as the password and ignores the username
// (audiofield-io.md §5.5); this is the constant it ignores.
export const GIT_CREDENTIAL_USERNAME = 'field';

// Paths relative to the API base. Functions where a path carries a
// project, so a caller cannot misplace the segments.
export const paths = {
  hello: '/api/hello',
  deviceCode: '/api/device/code',
  deviceToken: '/api/device/token',
  revoke: '/api/token',
  project: (owner: string, project: string) => `/api/projects/${owner}/${project}`,
  missing: (owner: string, project: string) =>
    `/api/projects/${owner}/${project}/artifacts/missing`,
  artifact: (owner: string, project: string, actionKey: string) =>
    `/api/projects/${owner}/${project}/artifacts/${actionKey}`,
  offer: (owner: string, project: string) => `/api/projects/${owner}/${project}/artifacts`,
  complete: (owner: string, project: string, actionKey: string) =>
    `/api/projects/${owner}/${project}/artifacts/${actionKey}/complete`,
} as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256');

// A handle or project name: the site's grammar is a Field slug's
// (audiofield-io.md §3, project-model.md "Identity: names, not UUIDs").
export const remoteName = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a lowercase slug');

export const helloResponseSchema = z.object({
  protocol: z.number().int(),
  version: z.string(),
  features: z.array(z.string()).default([]),
});
export type RemoteHello = z.infer<typeof helloResponseSchema>;

// Device authorization (RFC 8628 §3.2), so every client library and
// every reviewer already knows the field names. `interval` defaults to
// the RFC's five seconds when the server omits it.
export const deviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});
export type DeviceCode = z.infer<typeof deviceCodeResponseSchema>;

export const deviceTokenRequestSchema = z.object({ device_code: z.string() });

// The token poll (RFC 8628 §3.4–3.5): a token, or one of the four error
// codes the RFC names. `login` is the handle the token belongs to, for
// the "logged in as" line; a server that omits it is still correct.
export const deviceTokenResponseSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    token_type: z.literal('bearer'),
    login: remoteName.optional(),
  }),
  z.object({
    error: z.enum(['authorization_pending', 'slow_down', 'access_denied', 'expired_token']),
  }),
]);
export type DeviceTokenResponse = z.infer<typeof deviceTokenResponseSchema>;

// Resolve `<owner>/<project>`. A private project the token cannot see is
// a 404, the same answer as for one that does not exist
// (audiofield-io.md §9.9), so the CLI never learns the difference.
export const projectResponseSchema = z.object({
  clone_url: z.string().url(),
  default_branch: z.string(),
  visibility: z.enum(['public', 'private']),
});
export type RemoteProject = z.infer<typeof projectResponseSchema>;

// "Which of these do you lack": action keys in, the subset the remote
// lacks out. Idempotent, and unauthenticated on public projects so a
// stranger's build can read through.
export const missingRequestSchema = z.object({ action_keys: z.array(sha256Hex) });
export const missingResponseSchema = z.object({ missing: z.array(sha256Hex) });

// An action entry as the remote holds it: `ActionEntry` (graph/build.ts)
// plus a presigned download URL per output. The CLI writes it as-is once
// every output's bytes have been hashed against `sha256` and counted
// against `bytes` — a fetched blob that disagrees never reaches the CAS.
export const artifactOutputSchema = z.object({
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
  url: z.string().url(),
});
export const artifactEntrySchema = z.object({
  rule: z.string(),
  outputs: z.array(artifactOutputSchema).min(1),
});
export type RemoteArtifactEntry = z.infer<typeof artifactEntrySchema>;

// The offer (remote.md §3.3): the entry, and the commit and label it
// satisfies, which are what the site indexes for its player. The reply
// is presigned upload URLs for the outputs the remote lacks; a
// completion call afterwards is what registers the entry, so a crashed
// upload never registers a partial one.
export const offerRequestSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
  label: z.string(),
  action_key: sha256Hex,
  rule: z.string(),
  outputs: z.array(z.object({ sha256: sha256Hex, bytes: z.number().int().nonnegative() })).min(1),
});
export type OfferRequest = z.infer<typeof offerRequestSchema>;
export const offerResponseSchema = z.object({
  uploads: z.array(z.object({ sha256: sha256Hex, url: z.string().url() })),
});
