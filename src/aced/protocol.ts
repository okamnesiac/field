import { z } from 'zod';

// The bloom-aced control protocol (ace-generation.md §3.3): NDJSON over
// .bloom/aced.sock, same family as bloom-audiod's. These schemas are the
// cross-language source of truth; python/aced/src/bloom_aced/protocol.py
// mirrors them.

export const ACED_PROTOCOL_VERSION = 1;

export const acedHelloResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemon: z.string(),
  version: z.string(),
  model_loaded: z.boolean(),
});

export const acedGenerateResponseSchema = z.object({
  ok: z.literal(true),
  paths: z.array(z.string()).min(1),
  seeds: z.array(z.number().int()),
  model: z.string(),
});

export const acedErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const acedOkResponseSchema = z.object({ ok: z.literal(true) });

export const acedEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('progress'), fraction: z.number(), stage: z.string() }),
]);
export type AcedEvent = z.infer<typeof acedEventSchema>;

export interface AceGenerateJob {
  prompt: string;
  duration_seconds: number;
  seed: number;
  variants: number;
  output_dir: string;
  lyrics?: string | undefined;
  bpm?: number | undefined;
}
