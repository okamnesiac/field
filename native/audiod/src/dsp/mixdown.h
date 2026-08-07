#pragma once

#include <vector>

// Summing: placed clips into a stem, and stems into a mix. The C++ side of
// render-pipeline.md chunk 3, transliterated from the loops in
// src/generators/stem.ts and mix.ts.
//
// Musical time is not here and never will be (decision 7). Bars, beats,
// tempo maps and loop expansion all resolve in the control plane, and what
// arrives is a sample-accurate edit list: offsets, durations, gains. The
// daemon has no idea what a bar is, which is the sentence the whole design
// keeps true.
//
// Both outputs are stereo. Mono sources feed both channels.

namespace field::dsp
{

struct PlacedClip
{
    int input = 0;      // index into the source list
    long start = 0;     // stem sample where the window begins
    long duration = 0;  // window length in samples
    // Sample of the source playing at the window start. May be negative or
    // run past the end: out-of-range reads are silence, so slipping never
    // errors.
    long readOffset = 0;
    double gainDb = 0.0;
    // Kept as doubles because they are divisors in the fade ramps, and the
    // reference computes those in floating point. Integer division here
    // would quietly floor every partial ramp to zero.
    double fadeIn = 0.0;
    double fadeOut = 0.0;
};

// Sum placed clips over their sources. Output length is the furthest clip
// end, matching the reference exactly — including the empty case.
std::vector<std::vector<float>> sumClips (const std::vector<std::vector<std::vector<float>>>& sources,
                                          const std::vector<PlacedClip>& clips);

struct Fader
{
    double gainDb = 0.0;
    double pan = 0.0; // −1 left … +1 right
};

// Constant-power balance (mix-assembly.md §4): unity at centre, cosine
// taper of the opposite side toward the edges.
void balanceGains (double pan, double& left, double& right);

// Sum stems through their faders. Output length is the longest stem.
std::vector<std::vector<float>> sumStems (const std::vector<std::vector<std::vector<float>>>& stems,
                                          const std::vector<Fader>& faders);

// The declared length, applied last — after the master chain, so even a
// tail the chain grew respects the bar line. With `loop`, the overhang
// folds back onto the start (one pass of the infinite performance);
// without it the tail is cut and short content pads.
void applyDeclaredLength (std::vector<std::vector<float>>& channels, long declared, bool loop);

} // namespace field::dsp
