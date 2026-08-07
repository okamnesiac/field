#pragma once

#include <vector>

// Offline lookahead peak limiter — the C++ side of the port
// (render-pipeline.md decision 4, where this is the one of the three
// judged genuinely better than JUCE's). Transliterated from
// src/audio/limiter.ts.
//
// Offline affords the artifact-free construction real-time limiters
// approximate: compute the per-sample gain that would pin every peak to
// the ceiling, then slew it dB-linearly — a backward pass so gain is
// already down when a peak arrives (the "lookahead" is the attack ramp
// length), and a forward pass so recovery follows the release time.
// Slewing only ever lowers gain below the naive curve, so the ceiling is a
// hard guarantee, and dB-linear ramps are click-free by construction.
//
// The distinction from juce::dsp::Limiter, which is "two compressors and a
// hard clipper at 0 dB": this reaches an *arbitrary* ceiling by gain
// reduction rather than by clipping the transients that get there.

namespace field::dsp
{

struct LimiterSettings
{
    double ceilingDb = -1.0;
    double lookaheadMs = 5.0; // attack ramp length
    double releaseMs = 100.0;
    double sampleRate = 48000.0;
};

// Shared gain curve across channels (stereo-linked: limiting must not
// wander the image), applied in place.
void limit (std::vector<std::vector<float>>& channels, const LimiterSettings& settings);

} // namespace field::dsp
