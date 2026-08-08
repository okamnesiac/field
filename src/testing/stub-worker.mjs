#!/usr/bin/env node
// A generation worker that speaks the protocol and generates nothing.
//
// Pointed at by FIELD_ACED_PYTHON / FIELD_VOICED_PYTHON, which the client
// treats as "an interpreter that can import the worker" (ace-generation.md
// §3.4) and invokes as `<override> -m <module> --socket <path>`. A shebang
// script satisfies that shape, so a test gets the real client, the real
// socket, real NDJSON framing and a real spawn — with no model, no weights
// and no Python.
//
// What this covers that the live daemon tests do not: what `field generate`
// *sends* and what it *writes* afterwards. The wire protocol itself is
// covered the other way round, by src/{aced,voiced}/client.test.ts against
// the real daemons — so neither test is asserting against its own fixture.
//
// Every request is appended to .field/stub-requests.ndjson beside the
// socket, which is how a test sees that voice_ref arrived as a resolved
// path rather than an asset name.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This stub impersonates a *current* worker, so its protocol number has
// to be the current one — read from the source of truth rather than
// restated here. Restating it means every future bump silently turns the
// stub into a daemon the client refuses, and the failure lands in a
// dozen unrelated `field generate` tests rather than saying "the stub is
// stale" (#69: the bump to 2 did exactly that).
const PROTOCOL = Number(
  /WORKER_PROTOCOL_VERSION = (\d+)/.exec(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'workers', 'protocol.ts'),
      'utf8',
    ),
  )[1],
);

const argv = process.argv.slice(2);
const module = argv[argv.indexOf('-m') + 1] ?? 'field_aced';
const socketPath = argv[argv.indexOf('--socket') + 1];
if (!socketPath) {
  process.stderr.write('stub-worker: --socket is required\n');
  process.exit(2);
}

// field_voiced -> field-voiced. The client checks this against the spec it
// connected with (#60 review), so a stub answering with the wrong name
// would be refused — which is the point: this impersonates one worker, not
// "a worker".
const daemon = module.replace(/_/g, '-');
const requestLog = join(dirname(socketPath), 'stub-requests.ndjson');

mkdirSync(dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });

const server = createServer((socket) => {
  let buffer = '';
  const send = (message) => socket.write(JSON.stringify(message) + '\n');

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      appendFileSync(requestLog, line + '\n');
      handle(request, send);
    }
  });

  // One client, and the process is its lifetime: `field generate` closes
  // without quitting, and a stub that outlived the test would hold the
  // socket for the next one.
  socket.on('close', () => {
    server.close();
    process.exit(0);
  });
});

// Announce that we have reached `at`, then block until the test says go.
// Blocking on purpose: it stands in for work that would occupy the worker
// anyway, and it keeps the ordering the test asserts on.
function waitAt(hold, at, until) {
  if (!hold) return;
  writeFileSync(`${hold}.${at}`, '');
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!existsSync(`${hold}.${until}`) && Date.now() < deadline) {
    Atomics.wait(idle, 0, 0, 20);
  }
}

function handle(request, send) {
  const { id, op } = request;
  if (op === 'hello') {
    send({ id, ok: true, protocol: PROTOCOL, daemon, version: 'stub', model_loaded: false });
    return;
  }
  if (op === 'quit') {
    send({ id, ok: true });
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (op !== 'generate') {
    send({ id, ok: false, error: `unknown op "${op}"` });
    return;
  }
  send({ event: 'progress', fraction: 0.5, stage: 'stubbing' });
  // A real worker reads the reference here — after startup, after the
  // model loads — not when the CLI resolved it. FIELD_STUB_HOLD lets a
  // test open that window on purpose and edit the recording inside it:
  // the stub announces it has reached the read and waits for a go-ahead.
  const hold = process.env.FIELD_STUB_HOLD;
  // Two hold points, because one is not enough to tell a real fix from a
  // plausible one. Pausing *before* the read lets a test swap the
  // recording under the worker; pausing *after* it lets the test put the
  // recording back before generate returns. Only the second one exposes
  // change-and-restore, where every after-the-fact comparison sees the
  // original and passes while the audio came from something else.
  waitAt(hold, 'ready', 'go');
  // What the worker actually heard, which is the only thing that makes
  // "the recipe pins the bytes the model read" checkable (#61 review).
  const heard = request.voice_ref
    ? createHash('sha256').update(readFileSync(request.voice_ref)).digest('hex')
    : null;
  waitAt(hold, 'read', 'resume');
  appendFileSync(requestLog, JSON.stringify({ op: 'read', voice_ref_sha256: heard }) + '\n');
  const count = request.variants;
  const paths = [];
  const seeds = [];
  mkdirSync(request.output_dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const seed = request.seed + i;
    const path = join(request.output_dir, `stub-${seed}.wav`);
    // Distinct per seed, so a test can tell the variants apart by hash and
    // catch a recipe that pairs a file with the wrong one.
    writeFileSync(path, `stub audio seed=${seed}\n`);
    paths.push(path);
    seeds.push(seed);
  }
  send({ id, ok: true, paths, seeds, model: `${daemon}-stub` });
}

server.listen(socketPath);
