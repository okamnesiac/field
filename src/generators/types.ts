import type { BuildableSound } from '../schema/index.js';
import type { MixSpec } from './mix.js';
import type { StemSpec } from './stem.js';

// A Generator is a pluggable module that generates a type of sound
// automatically — §1.2's "one generator category, two trigger policies"
// expressed as code. The engine (graph/build.ts) owns caching, keys,
// and ordering; each Generator owns everything type-specific: wiring,
// validation, inputs, execution, and post-run integrity. SuperCollider
// is not special; it is one programmable synth behind this interface,
// and the mixer arrives the same way. A deliberate type (`generate`)
// has no Generator here — its generation is human-triggered
// (field generate), which is what BuildableSound encodes. A Generator's
// spec is either a declared sound (sounds/<name>.yaml) or a spec
// synthesized from the project model (stem from track files, mix from
// mixes/). Each is typed against its own spec —
// Generator<NormalizeSound> and so on — so per-method "wrong type"
// narrowing is proven by the compiler.

export type GeneratorSpec = BuildableSound | StemSpec | MixSpec;

export interface RunContext {
  root: string; // absolute project root
  sampleRate: number; // project sample rate
}

// The song's visible names, pre-classified for source resolution
// (project-layout.md §4.3): a bare slug means exactly one thing in the
// song's unified namespace, a //shared/asset: label crosses scope.
export interface SourceNames {
  assets: Set<string>; // the song's ledger
  sounds: Set<string>; // buildable sounds (have a rule)
  chosen: Set<string>; // generate sounds with a chosen variant
  unchosen: Set<string>; // generate sounds not yet chosen
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
