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
//
// The streaming form computes the identical gain curve causally
// (realtime.md decision 3): a peak's backward influence dies out at
// depth/attackSlope samples, so a bounded pending window sees everything
// the backward pass consulted. Incremental backward propagation on each
// arrival equals the offline sweep bit-for-bit, because float min and
// adding a constant are both monotone — the min of propagated candidates
// is the propagated min.

namespace field::dsp
{

struct LimiterSettings
{
    double ceilingDb = -1.0;
    double lookaheadMs = 5.0; // attack ramp length
    double releaseMs = 100.0;
    double sampleRate = 48000.0;
};

// The limiter as a streaming processor. process() consumes a block and
// appends every sample whose gain is final to `out`, which lags the
// input by up to latencySamples(); flush() drains the rest, so wrapper
// output aligns sample-for-sample with input. The pending window covers
// the deepest reduction any finite float input can demand (FLT_MAX over
// the ceiling), so the streaming curve is the whole-buffer sweep's for
// every finite signal; infinities clamp to FLT_MAX. That sizes the
// window for exactness, not for monitoring — a live construction may
// later choose a shallower horizon knowingly, which is chunk 2's call.
class Limiter
{
public:
    // horizonDb bounds the pending window's reduction depth. At or below
    // zero (the default) it covers the deepest reduction any finite
    // float can demand — the offline wrapper's exactness. A live
    // construction passes a shallower figure (realtime.md chunk 2 sets
    // 60 dB — one attack ramp of latency): reductions past it start
    // their ramp late, the ceiling still holds at the peak itself, and
    // the committed render never uses this path.
    Limiter (const LimiterSettings& settings, size_t numChannels, double horizonDb = 0.0);
    void process (const std::vector<std::vector<float>>& block,
                  std::vector<std::vector<float>>& out);
    void flush (std::vector<std::vector<float>>& out);
    long latencySamples() const { return (long) capacity; }

private:
    void push (const std::vector<std::vector<float>>& block,
               size_t frame,
               std::vector<std::vector<float>>& out);
    void emitOldest (std::vector<std::vector<float>>& out);

    double ceiling = 1.0;
    double attackSlope = 0.0;
    double releaseSlope = 0.0;
    size_t numChannels = 0;
    size_t capacity = 0;

    // Pending rings: samples awaiting a final gain, and the gain curve
    // under incremental backward propagation.
    std::vector<std::vector<float>> pending; // [channel][ring]
    std::vector<double> gainDb; // [ring]
    size_t head = 0;
    size_t count = 0;
    double previousOut = 0.0; // release recurrence state
};

// Shared gain curve across channels (stereo-linked: limiting must not
// wander the image), applied in place — one Limiter over the entire
// signal; the whole-buffer form render.cpp's limit insert uses.
void limit (std::vector<std::vector<float>>& channels, const LimiterSettings& settings);

} // namespace field::dsp
