import { z } from 'zod';

// The wire shapes every generation worker shares — the TypeScript mirror
// of python/worker/src/field_worker/protocol.py, and the cross-language
// source of truth for both.
//
// The generate *response* is shared rather than per-worker because
// `GenerationOutput` is shared on the Python side: paths, the seeds they
// were made with, and the model that made them is what a recipe records,
// whichever model that was.

export const WORKER_PROTOCOL_VERSION = 1;

export const workerHelloResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.number().int(),
  daemon: z.string(),
  version: z.string(),
  model_loaded: z.boolean(),
});

export const workerGenerateResponseSchema = z
  .object({
    ok: z.literal(true),
    paths: z.array(z.string()).min(1),
    seeds: z.array(z.number().int()),
    model: z.string(),
  })
  .refine((r) => r.paths.length === r.seeds.length, {
    message: 'paths and seeds must align — the recipe pairs them by index',
  });

export const workerErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const workerOkResponseSchema = z.object({ ok: z.literal(true) });

export const workerEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('progress'), fraction: z.number(), stage: z.string() }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;

// What distinguishes one worker from another, which is only ever naming:
// where its socket lives, which uv project runs it, which module a bare
// interpreter imports, and what to call it in an error message.
export interface WorkerSpec {
  name: string; // 'field-aced'
  packageDir: string; // 'aced' — under python/
  module: string; // 'field_aced' — for `python -m`
  script: string; // 'field-aced' — the [project.scripts] entry point
  socketRelative: string; // '.field/aced.sock'
  logRelative: string; // '.field/aced.log'
  pythonOverrideEnv: string; // 'FIELD_ACED_PYTHON'
}
