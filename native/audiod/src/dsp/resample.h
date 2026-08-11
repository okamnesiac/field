#pragma once

#include <vector>

// Sample-rate conversion and bit-depth reduction for the built-in tier
// (render-pipeline.md decisions 9 and 10). This is the work that retires
// the last `afconvert` call, so it has no TypeScript reference to
// transliterate — unlike every other file in this directory, what it must
// do is stated by properties rather than by a prior implementation.
//
// Fixed-ratio polyphase. The six rates field supports are pairwise
// rational with small denominators (44100→48000 is exactly 160/147), so
// every conversion has L phases whose coefficient rows can be computed
// once and reused for the whole file. The prototype is a Kaiser-windowed
// sinc with its stopband edge at the LOWER of the two Nyquist
// frequencies, which is the detail that makes one routine correct in both
// directions: filtering at the input Nyquist while decimating is exactly
// the aliasing bug that ruled out JUCE's interpolator.
//
// Everything here is scalar double with no FMA contraction, for the
// reason §4 gives. It is roughly 3× slower than afconvert's vectorised
// path and that is the trade being made deliberately, not an oversight —
// `normalize` is cached by action key, so it runs once per source.

namespace field::dsp
{

// The reduced ratio outRate/inRate. Exposed for the tests, which assert
// the reduction rather than trusting it.
struct Ratio
{
    long phases = 1; // L — upsampling factor
    long stride = 1; // M — decimation factor
};

Ratio ratioFor (double inRate, double outRate);

// The converter as a streaming processor (realtime.md decision 7): the
// same polyphase kernel fed by a taps-wide ring of input history, primed
// with the zeros before the source. process() appends every output whose
// window is complete — the stream lags the input by latencySamples()
// (the prototype's taps/2 group delay) — and flush() emits the rest,
// reading silence past the end, honouring the whole-buffer length rule
// (round, and never round a non-empty source to zero). Any block
// partitioning emits the same bits. A 1:1 ratio is passthrough(); the
// caller skips the filter entirely, as the whole-buffer form always has.
class Resampler
{
public:
    Resampler (double inRate, double outRate, size_t numChannels);
    bool passthrough() const { return phases == 1 && stride == 1; }
    void process (const std::vector<std::vector<float>>& block,
                  std::vector<std::vector<float>>& out);
    void flush (std::vector<std::vector<float>>& out);
    long latencySamples() const;

private:
    void emitReady (std::vector<std::vector<float>>& out, long inputLimit);

    long phases = 1;
    long stride = 1;
    long taps = 0;
    long delay = 0;
    std::vector<double> rows;
    std::vector<std::vector<float>> history; // [channel][taps ring]
    size_t numChannels = 0;
    long consumed = 0; // input samples seen
    long emitted = 0; // output samples emitted
};

// Resamples every channel. Returns the input untouched when the rates
// match — not an optimisation but a correctness requirement, since a
// same-rate "conversion" must not run a filter over the signal.
std::vector<std::vector<float>> resample (const std::vector<std::vector<float>>& channels,
                                          double inRate,
                                          double outRate);

// Rounds every sample onto the quantization grid for `bitDepth`, with
// 1-LSB TPDF dither applied first — at 16 and 24 only. All three depths
// are written as integer PCM by writeWavInt; what differs is where the
// quantization happens. At 16 and 24 it happens here, dithered, and the
// writer's scale-and-round is then exact because the samples already sit
// on a power-of-two grid. At 32 this returns untouched and the writer
// does the quantization undithered, because that step is about 186 dB
// down — finer than the float32 samples feeding it can resolve except at
// the very bottom of the range (decision 10, #57 review).
//
// The dither sequence is a specified PRNG with a fixed seed (decision
// 10). Not <random>: the pairing of std::mt19937 with
// std::uniform_real_distribution is not guaranteed to yield the same
// sequence on libstdc++ and libc++, which would make rendered artifacts
// platform-dependent.
void ditherTo (std::vector<std::vector<float>>& channels, int bitDepth);

} // namespace field::dsp
