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

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

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

function handle(request, send) {
  const { id, op } = request;
  if (op === 'hello') {
    send({ id, ok: true, protocol: 1, daemon, version: 'stub', model_loaded: false });
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
