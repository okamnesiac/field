// Compile the graph into a live session (realtime.md §3, chunk 2).
//
// ARCHITECTURE (settled in design, implementation in progress):
//
// The graph's track nodes already carry each track's full StemSpec —
// resolved clips at the track's rate, sources as ordered refs matching
// node.deps. The compiler transforms those specs instead of re-planning:
//
// 1. The caller builds every stem's *dependencies* first (sources, gen
//    artifacts, converts) via buildLabels, which returns label →
//    outputPath; stems themselves are not built — they are what the
//    engine evaluates live.
// 2. Each spec source classifies three ways: a track stem ref becomes a
//    `track` window (the child's live output ring read at a delay); a
//    tap ref (`tap:<sender>`) becomes a `receive` window reading the
//    sender's pre-chain ring; anything else is a `file` window naming
//    the built or committed path. Window fields copy the clip verbatim
//    — same units, same omit-when-centred pan.
// 3. Latency is compiler arithmetic, never engine arithmetic
//    (playback.md §3.6's division of labour): chain latency is the
//    limiter's horizon window (horizon_db at 60 dB — one attack ramp —
//    per session.ts) and zero for eq/reverb; an edge whose rates differ
//    adds the streaming resampler's taps/2 group delay; a track's
//    accumulated latency is max over inputs plus its chain's; each
//    summing input carries comp_delay = maxSibling − own, so unequal
//    paths arrive aligned. The engine only applies offsets.
// 4. Windows whose start − read_offset would need future child samples
//    (a negative live delay) are a compile diagnostic — live taps only
//    ever delay.
// 5. The session's clock is the song's rate; length_samples/loop come
//    from the output track's declared extent, and the clock wraps
//    sample-exactly — the loop-takeover machinery this retires.
//
// The daemon-side mirror is native/audiod/src/live.{h,cpp}: per-track
// output rings (post-chain, at the track's rate) plus a pre-chain ring
// where any cable taps pre; consumers read rings through per-edge
// streaming Resamplers when rates differ; ramps land as dB-linear
// glides at block boundaries (decision 5).

import type { LoadedProject } from '../model/project.js';
import type { Session } from '../audiod/session.js';

export function compileSession(_project: LoadedProject, _song: string): Session {
  throw new Error('chunk 2 in progress: compileSession lands with the live engine');
}
