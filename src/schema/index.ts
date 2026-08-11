// The schema module's public surface: one file per project-file domain,
// re-exported here so consumers keep a single import path. Zod schemas
// are the single source of truth for the canonical project format
// (project-core.md §1); JSON Schema is generated from them to keep the
// format language-neutral (§5). Each schema ships with the KeyOrder used
// for deterministic emission (§3.6).

export * from './common.js';
export * from './manifest.js';
export * from './song.js';
export * from './assets.js';
export * from './effects.js';
export * from './generative.js';
export * from './track.js';
