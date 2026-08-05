import type { Target } from '../schema/schemas.js';

// A build rule is a pluggable module. The engine (graph/build.ts) knows
// that rules exist — it owns caching, keys, and ordering — and rule modules
// own everything rule-specific: wiring, validation, inputs, execution, and
// post-run integrity. SuperCollider is not special; it is one programmable
// synth behind this interface, and ACE and the mixer arrive the same way.

export interface RunContext {
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

export interface RuleImpl {
  version: number; // bumped to invalidate cached outputs (§3.5)
  // Fields that are identity or wiring rather than knobs; excluded from
  // parameter hashing (name and rule are always excluded).
  wiringFields: readonly string[];
  // Names of same-song assets this target consumes (graph edges).
  assetDeps(target: Target): string[];
  // Rule-specific semantic validation, run by bloom check.
  validate(target: Target, ctx: ValidateContext): void;
  // Inputs that participate in the action key by content hash without being
  // graph nodes (e.g. an sc program file).
  extraInputs?(root: string, target: Target): Promise<ExtraInput[]>;
  // The path handed to execute(); assetPaths are the resolved absolute
  // paths of assetDeps, in order.
  inputPath(root: string, target: Target, assetPaths: string[]): string;
  execute(target: Target, inputPath: string, outputPath: string, ctx: RunContext): Promise<void>;
  // Post-run integrity: refuse to cache if an extra input changed mid-run.
  verifyAfterRun?(root: string, target: Target, extraInputs: ExtraInput[]): Promise<void>;
}
