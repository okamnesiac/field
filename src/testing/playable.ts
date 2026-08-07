import type { Playable } from '../commands/play.js';

// A Playable for tests, with every field the interface requires filled
// in. Hand-built literals break each time the interface gains a required
// field, and they break in a way CI is bad at catching: `sha256` in #35
// (invisible to vitest, which does not typecheck, and to the build,
// which excludes tests), `committed` in #39, and again when merging #38
// into #39 — a type error neither branch's own CI could see, because a
// conflicting pull request has no merge ref to build.
//
// `path` has no default on purpose: a Playable's whole job is to name a
// file, and a defaulted path would turn a missing fixture into an ENOENT
// somewhere far away instead of a compile error here.
//
// The trade this shape makes, deliberately: a future required field gets
// whatever default is written here, so a test can end up asserting on a
// value nobody chose for it (#40 review). The compile errors it replaces
// asked that question at every call site; this asks it once, in the
// open, of whoever adds the field. So give a new field a default only
// where every caller would be indifferent to it — otherwise leave it out
// of the defaults, like `path`, and let the compiler ask.
export function playable(overrides: Partial<Playable> & Pick<Playable, 'path'>): Playable {
  const label = overrides.label ?? '//songs/x/mix:main';
  return {
    label,
    // The label's package, which is what callers would have written by
    // hand anyway — and getting it wrong is silent, since it only shows
    // up as a missing tempo map much later.
    pkg: label.replace(/^\/\//, '').split(':')[0] ?? '',
    sha256: 'deadbeef'.repeat(8),
    committed: false,
    ...overrides,
  };
}
