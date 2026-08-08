// field-aced's own half of the protocol: what an ACE job is. The shared
// shapes — hello, ok/error, the generate response, progress events — are
// src/workers/protocol.ts, mirrored in Python by field_worker.protocol.
//
// The per-worker copies of those schemas lived here until #60. They were
// dead the moment the client moved to the shared ones, and their tests
// went on passing against the copies — testing a schema nothing parsed
// with while the schema everything parsed with had none (#60 review).

export interface AceGenerateJob {
  prompt: string;
  duration_seconds: number;
  seed: number;
  variants: number;
  output_dir: string;
  lyrics?: string | undefined;
  bpm?: number | undefined;
}
