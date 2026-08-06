import type { BuildableSound } from '../schema/index.js';
import type { MixSpec } from './mix.js';
import type { TrackRenderSpec } from './track-render.js';

// A build rule is a pluggable module. The engine (graph/build.ts) knows
// that rules exist — it owns caching, keys, and ordering — and rule modules
// own everything rule-specific: wiring, validation, inputs, execution, and
// post-run integrity. SuperCollider is not special; it is one programmable
// synth behind this interface, and the mixer arrives the same way.
//
// "Rule" is deliberately the engine's word (project-layout.md §4): a
// sound declares a `type:`, and a rule is the mechanical executor a type
// may or may not have — `generate` has none, which is exactly the §1.2
// trigger policy, encoded as BuildableSound. A rule's spec is either a
// declared sound (sounds/<name>.yaml) or a spec synthesized from the
// project model (track-render from track files, mix from mixes/). Each
// impl is typed against its own spec — RuleImpl<NormalizeSound> and so
// on — so per-method "wrong rule" narrowing is proven by the compiler.

export type RuleSpec = BuildableSound | TrackRenderSpec | MixSpec;

export interface RunContext {
  root: string; // absolute project root
  sampleRate: number; // project sample rate
}

// The song's visible names, pre-classified for source resolution
// (project-layout.md §4.3): a bare slug means exactly one thing in the
// song's unified namespace, a //shared/assets: label crosses scope.
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

export interface RuleImpl<T extends RuleSpec = RuleSpec> {
  version: number; // bumped to invalidate cached outputs (§3.5)
  // Fields that are identity or wiring rather than knobs; excluded from
  // parameter hashing (name and type are always excluded).
  wiringFields: readonly string[];
  // Ordered node-backed sources this spec consumes — bare names in the
  // song's namespace or //shared/assets: labels; the graph classifies
  // each into an asset, sound, or shared edge. Program files are not
  // here: they participate by content hash (extraInputs), not as nodes.
  sources(spec: T): string[];
  // Rule-specific semantic validation, run by bloom check.
  validate(spec: T, ctx: ValidateContext): void;
  // Inputs that participate in the action key by content hash without being
  // graph nodes (e.g. a SuperCollider program file).
  extraInputs?(root: string, spec: T): Promise<ExtraInput[]>;
  // inputPaths are the resolved absolute paths of sources(), in order.
  execute(spec: T, inputPaths: string[], outputPath: string, ctx: RunContext): Promise<void>;
  // Post-run integrity: refuse to cache if an extra input changed mid-run.
  verifyAfterRun?(root: string, spec: T, extraInputs: ExtraInput[]): Promise<void>;
}
