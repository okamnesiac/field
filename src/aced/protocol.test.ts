import { describe, expect, it } from 'vitest';
import {
  acedEventSchema,
  acedGenerateResponseSchema,
  acedHelloResponseSchema,
} from './protocol.js';

// The daemon side is Python (python/aced mirrors these shapes, gated by
// pyright strict); these tests pin the TS half of the contract. Live
// protocol behavior was verified against the real daemon by hand — CI
// doesn't carry the multi-GB model environment.

describe('aced protocol schemas', () => {
  it('parses the hello handshake', () => {
    expect(
      acedHelloResponseSchema.parse({
        ok: true,
        protocol: 1,
        daemon: 'bloom-aced',
        version: '0.1.0',
        model_loaded: false,
      }).model_loaded,
    ).toBe(false);
  });

  it('parses generate responses and rejects empty output', () => {
    const parsed = acedGenerateResponseSchema.parse({
      ok: true,
      paths: ['/tmp/a.wav', '/tmp/b.wav'],
      seeds: [90210, 90211],
      model: 'acestep-v15-turbo',
    });
    expect(parsed.seeds).toEqual([90210, 90211]);
    expect(() =>
      acedGenerateResponseSchema.parse({ ok: true, paths: [], seeds: [], model: 'm' }),
    ).toThrow();
  });

  it('parses progress events and ignores unknown ones', () => {
    expect(
      acedEventSchema.parse({ event: 'progress', fraction: 0.1, stage: 'generating' }).stage,
    ).toBe('generating');
    expect(acedEventSchema.safeParse({ event: 'mystery' }).success).toBe(false);
  });
});
