import type { ResampleSpec } from './resample.js';
import type { StemSpec } from './stem.js';

// A Generator owns everything type-specific about realizing one spec
// kind — wiring, validation, inputs, execution, post-run integrity —
// while the engine (graph/build.ts) owns caching, keys, and ordering.
// Every spec is synthesized from the project model, never parsed from a
// file of its own: a supercollider entry's render, a stem from a track
// file, a resample from a rate-mismatched edge. Each is typed against
// its own spec — Generator<SupercolliderSound> and so on — so
// per-method "wrong type" narrowing is proven by the compiler.

// The spec behind a `supercollider:` entry's gen node, rendered offline
// (NRT) via sclang with FIELD_OUTPUT / FIELD_SEED / FIELD_DURATION /
// FIELD_SAMPLE_RATE / FIELD_CHANNELS in the environment; the program
// must write FIELD_OUTPUT and exit. Determinism given the seed is the
// program's job; the program's content hash is the cache input. The
// graph synthesizes this from the entry — name and type join the
// entry's own fields, so the action key sees exactly the authored
// parameters (schema/track.ts supercolliderEntrySchema).
export interface SupercolliderSound {
  name: string;
  type: 'supercollider';
  source: string; // the program; bare names resolve in shared/instruments/
  seed: number;
  duration: number; // seconds
  channels: 1 | 2;
}

export type GeneratorSpec = SupercolliderSound | StemSpec | ResampleSpec;

export interface RunContext {
  root: string; // absolute project root
  // The rate this node renders at (multi-rate.md decision 3): the owning
  // track's effective rate for stems and entry generators, the project
  // rate for declared sounds. Before rate: existed these were one number.
  sampleRate: number;
  // Cancellation, when the caller has a reason to stop mid-build — the
  // watch loop's background freeze on ctrl-c. Executors that spawn pass
  // it to the child; the cache stays consistent either way, because the
  // action entry is only written after a completed run.
  signal?: AbortSignal;
}

// The song's visible names, pre-classified for source resolution
// (project-layout.md §4.3): a bare slug means exactly one thing in the
// song's namespace, a //shared/asset: label crosses scope. What is
// resolvable by bare name is committed bytes.
export interface SourceNames {
  assets: Set<string>; // the song's ledger
  shared: Set<string>; // the shared ledger
}

export interface ValidateContext {
  root: string; // absolute project root
  songDir: string; // project-relative song directory
  names: SourceNames;
  push: (message: string) => void; // report a diagnostic
  // Resolve a file reference safely (relative, inside the project, exists,
  // regular file); baseDir is project-relative ('' = project root).
  resolveFile: (baseDir: string, file: string) => { path?: string; problem?: string };
}

export interface ExtraInput {
  label: string; // display label (a path for file inputs)
  sha256: string;
}

export interface Generator<T extends GeneratorSpec = GeneratorSpec> {
  version: number; // bumped to invalidate cached outputs (§3.5)
  // Fields that are identity or wiring rather than knobs; excluded from
  // parameter hashing (name and type are always excluded).
  wiringFields: readonly string[];
  // Ordered node-backed sources this spec consumes — bare names in the
  // song's namespace or //shared/asset: labels; the graph classifies
  // each into an asset, sound, or shared edge. Program files are not
  // here: they participate by content hash (extraInputs), not as nodes.
  sources(spec: T): string[];
  // Rule-specific semantic validation, run by field check.
  validate(spec: T, ctx: ValidateContext): void;
  // Inputs that participate in the action key by content hash without being
  // graph nodes (e.g. a SuperCollider program file).
  extraInputs?(root: string, spec: T): Promise<ExtraInput[]>;
  // inputPaths are the resolved absolute paths of sources(), in order.
  execute(spec: T, inputPaths: string[], outputPath: string, ctx: RunContext): Promise<void>;
  // Post-run integrity: refuse to cache if an extra input changed mid-run.
  verifyAfterRun?(root: string, spec: T, extraInputs: ExtraInput[]): Promise<void>;
}
