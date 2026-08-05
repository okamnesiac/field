import type { Target } from '../schema/schemas.js';
import type { MixSpec } from './mix.js';
import type { TrackRenderSpec } from './track-render.js';

// A build rule is a pluggable module. The engine (graph/build.ts) knows
// that rules exist — it owns caching, keys, and ordering — and rule modules
// own everything rule-specific: wiring, validation, inputs, execution, and
// post-run integrity. SuperCollider is not special; it is one programmable
// synth behind this interface, and the mixer and ACE arrive the same way.
//
// A rule's spec is either a declared target (targets.yaml) or a spec
// synthesized from the project model (track-render, derived from track
// files). Each impl is typed against its own spec — RuleImpl<NormalizeTarget>
// and so on — so the per-method "wrong rule" narrowing the ungeneric
// interface forced is now proven by the compiler (the #7 review's deferred
// polish; the third rule was the agreed trigger).

export type RuleSpec = Target | TrackRenderSpec | MixSpec;

export interface RunContext {
  root: string; // absolute project root
  sampleRate: number; // project sample rate
}

export interface ValidateContext {
  root: string; // absolute project root
  songDir: string; // project-relative song directory
  assetNames: Set<string>; // asset names declared in this song
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
  // parameter hashing (name and rule are always excluded).
  wiringFields: readonly string[];
  // Names of same-song assets this spec consumes (graph edges).
  assetDeps(spec: T): string[];
  // Rule-specific semantic validation, run by bloom check.
  validate(spec: T, ctx: ValidateContext): void;
  // Inputs that participate in the action key by content hash without being
  // graph nodes (e.g. an sc program file).
  extraInputs?(root: string, spec: T): Promise<ExtraInput[]>;
  // inputPaths are the resolved absolute paths of assetDeps, in order.
  execute(spec: T, inputPaths: string[], outputPath: string, ctx: RunContext): Promise<void>;
  // Post-run integrity: refuse to cache if an extra input changed mid-run.
  verifyAfterRun?(root: string, spec: T, extraInputs: ExtraInput[]): Promise<void>;
}
