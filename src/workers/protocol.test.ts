import { describe, expect, it } from 'vitest';
import {
  workerEventSchema,
  workerGenerateResponseSchema,
  workerHelloResponseSchema,
} from './protocol.js';

// The shared worker contract: hello, the generate response, and the
// progress event, as every generation worker speaks them. The daemon side
// is Python (field_worker.protocol mirrors these shapes, gated by pyright
// strict); these tests pin the TS half.
//
// They used to live in src/aced/protocol.ts against per-worker copies,
// and went on passing there after the client moved to these schemas —
// testing shapes nothing parsed with, while the shapes everything parsed
// with had no tests at all (#60 review). Moved rather than duplicated,
// since the whole point is that there is one contract now.

describe('aced protocol schemas', () => {
  it('parses the hello handshake', () => {
    expect(
      workerHelloResponseSchema.parse({
        ok: true,
        protocol: 1,
        daemon: 'field-aced',
        version: '0.1.0',
        model_loaded: false,
      }).model_loaded,
    ).toBe(false);
  });

  it('parses generate responses and rejects empty output', () => {
    const parsed = workerGenerateResponseSchema.parse({
      ok: true,
      paths: ['/tmp/a.wav', '/tmp/b.wav'],
      seeds: [90210, 90211],
      model: 'acestep-v15-turbo',
    });
    expect(parsed.seeds).toEqual([90210, 90211]);
    expect(() =>
      workerGenerateResponseSchema.parse({ ok: true, paths: [], seeds: [], model: 'm' }),
    ).toThrow();
  });

  it('rejects misaligned paths/seeds (the recipe pairs them by index)', () => {
    expect(
      workerGenerateResponseSchema.safeParse({
        ok: true,
        paths: ['/tmp/a.wav'],
        seeds: [90210, 90211],
        model: 'acestep-v15-turbo',
      }).success,
    ).toBe(false);
  });

  it('parses progress events and ignores unknown ones', () => {
    expect(
      workerEventSchema.parse({ event: 'progress', fraction: 0.1, stage: 'generating' }).stage,
    ).toBe('generating');
    expect(workerEventSchema.safeParse({ event: 'mystery' }).success).toBe(false);
  });
});
