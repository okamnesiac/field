#pragma once

#include <vector>

// Dattorro's 1997 plate (reverbs.md decision 2): predelay, an input
// one-pole at the published bandwidth, four series input diffusers,
// then the figure-8 tank — two cross-fed branches of modulated allpass
// → delay → damping → decay → allpass → delay, with the published
// output tap table for stereo. The tunings are sample counts at
// 29 761 Hz and scale to the session rate by rounding, the way the
// Freeverb port's already do. Stereo input mono-sums into the tank (a
// plate is one sheet of metal); the taps are what make it wide.
//
// Decisions carried from the port next door (reverb.h), on purpose:
// the allpasses are the canonical Schroeder form, scaled lengths and
// taps ROUND rather than truncate, and `decay` means seconds-to-−60 dB
// — the per-circulation feedback derives from the actual scaled loop
// so the knob is measurable. The paper draws the tank's first diffuser
// sign-inverted and calls the choice one of decorrelation; this port
// keeps that sign (gain −0.70) and the fixed decay-diffusion pair
// (0.70, and clamp(decay gain + 0.15, 0.25, 0.50), the paper's own
// suggestion).
//
// Modulation is deterministic by construction (reverbs.md decision 4):
// each branch's allpass read point rides a sinusoid whose phase is a
// pure function of the unwrapped input-timeline index — the counter
// startAt() initialises and process() advances — at the detuned rates
// published below. modulation: 0 reads at exactly the integer length
// and is bit-frozen.

namespace field::dsp
{

// ≈1 Hz, detuned so the branches never phase-lock; part of the design
// the way the tap table is, so published here rather than buried.
constexpr double plateLfoRateLeft = 0.943; // Hz
constexpr double plateLfoRateRight = 1.117; // Hz

struct PlateSettings
{
    double mix = 0.3; // 0 dry … 1 wet
    double decaySeconds = 2.0; // T60
    double predelayMs = 0.0;
    double damping = 0.5; // in-tank one-pole: 0 bright … 1 dark
    double diffusion = 0.75; // input diffusion 1; #2 rides at 5/6 of it
    double modulation = 0.3; // tank motion; 0 = bit-frozen
    double sampleRate = 48000.0;
};

// The plate as a streaming processor: every line, filter and LFO phase
// carried across blocks, so any block partitioning emits the same
// bits. process() is in place and same-length — the wet path is the
// predelayed mono sum, the dry path is not delayed, exactly as the
// Freeverb port mixes them. The tail is emitted by processing silence:
// feed tailSamples() of zeros after the input ends. Zero latency — the
// predelay is the effect, not the pipeline.
class Plate
{
public:
    Plate (const PlateSettings& settings, size_t numChannels);
    void process (std::vector<std::vector<float>>& block);
    // Where this chain starts rendering on the unwrapped input
    // timeline (reverbs.md decision 4): zero offline and at load, the
    // warmup start at a locate — so by the time the audible position
    // arrives the LFO phase equals a from-the-top render's.
    void startAt (long long sample) { clock = sample; }
    // Predelay plus the T60 tail, the compiler's arithmetic exactly.
    long tailSamples() const { return (long) (predelaySamples + tailLength); }
    long latencySamples() const { return 0; }

private:
    struct Allpass
    {
        std::vector<double> buffer;
        size_t at = 0;
        double gain = 0.0;
    };
    // The modulated tank diffuser: nominal length plus an LFO-swept
    // excursion, read by linear interpolation.
    struct ModAllpass
    {
        std::vector<double> buffer;
        size_t at = 0;
        double gain = 0.0;
        long length = 0;
        double lfoRate = 1.0; // Hz
    };
    struct Delay
    {
        std::vector<double> buffer;
        size_t at = 0;
    };

    // Value written `ago` samples before the current write position.
    static double readAgo (const std::vector<double>& buffer, size_t at, long ago);

    std::vector<double> predelayLine; // mono ring of predelaySamples zeros
    size_t predelayAt = 0;
    double bandwidthState = 0.0;
    std::vector<Allpass> inputDiffusers; // four in series
    // The tank, index 0 = left branch, 1 = right.
    ModAllpass tankApf1[2];
    Delay tankDelay1[2];
    double dampState[2] = { 0.0, 0.0 };
    Allpass tankApf2[2];
    Delay tankDelay2[2];

    double mix = 0.3;
    double damping = 0.5;
    double decayGain = 0.5; // per-pass feedback, derived from T60
    long scaledTapOffsets[2][7] = {}; // the tap table at the session rate
    double excursionDepth = 0.0; // samples, fractional
    double sampleRate = 48000.0;
    size_t numChannels = 0;
    size_t predelaySamples = 0;
    size_t tailLength = 0;
    long long clock = 0; // unwrapped input-timeline index
};

// Output is input length + predelay + tail (to −60 dB, i.e. the T60),
// so this returns new buffers rather than working in place.
std::vector<std::vector<float>> plate (const std::vector<std::vector<float>>& channels,
                                       const PlateSettings& settings);

} // namespace field::dsp
