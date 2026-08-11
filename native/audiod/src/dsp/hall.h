#pragma once

#include <vector>

// A Jot feedback delay network (reverbs.md decision 3): eight delay
// lines whose lengths are mutually prime — snapped to primes after
// scaling, so coprimality survives `size` and the session rate — fed
// back through the Householder reflection I − (2/N)·11ᵀ, applied in
// O(N) as y = x − 2·mean(x). The factor of two is what makes it a
// reflection and therefore orthogonal, so stability is algebraic, not
// tuned. Each line carries an absorptive filter deriving per-band
// decay from three numbers: `decay` (mid T60), `decay_low` and
// `decay_high` (multipliers on it) — rooms keep their lows and lose
// their highs, exposed directly instead of through a damping
// euphemism. Input mono-sums through a predelay and four lattice
// diffusers (the plate's input stage shape with its own prime
// lengths); stereo is the orthogonal ± output tap pair, blended
// mid/side by `width`.
//
// The per-line absorption is a cascade of two tilt stages around the
// mid-band gain: a low shelf at lowCrossoverHz whose DC gain retargets
// the line to the low band's T60, and a high shelf at highCrossoverHz
// doing the same toward Nyquist — per line, from that line's actual
// length, which is what keeps every band's `decay·multiplier`
// measurable the way the plate's single T60 is. Each shelf blends the
// direct path with a THIRD-order one-pole cascade: a first-order
// blend never saturates in the 2.5 octaves between the high crossover
// and Nyquist, and measured ~25% slow there; three poles bring the
// measured high-band slope inside the same window the mid band holds.
//
// Modulation is deterministic by construction (reverbs.md decision 4):
// each line's read point rides its own sinusoid — eight detuned rates
// published below — whose phase is a pure function of the unwrapped
// input-timeline index that startAt() initialises and process()
// advances. modulation: 0 reads the integer length and is bit-frozen.

namespace field::dsp
{

// The absorption crossovers: below the first, `decay_low` governs;
// above the second, `decay_high`.
constexpr double hallLowCrossoverHz = 300.0;
constexpr double hallHighCrossoverHz = 4000.0;

// Per-line LFO rates, ≈1 Hz and mutually detuned so no pair of lines
// phase-locks; published like the plate's pair.
constexpr double hallLfoRates[8] = { 0.911, 0.967, 1.013, 1.061, 1.117, 1.171, 1.229, 1.283 };

struct HallSettings
{
    double mix = 0.3; // 0 dry … 1 wet
    double decaySeconds = 2.0; // mid-band T60
    double decayLow = 1.0; // low-band multiplier on decay
    double decayHigh = 0.5; // high-band multiplier on decay
    double size = 1.0; // delay-line scale: small room → hall
    double predelayMs = 0.0;
    double diffusion = 0.8; // input diffusion 1; #2 rides at 5/6 of it
    double modulation = 0.3; // line motion; 0 = bit-frozen
    double width = 1.0; // stereo taps blended mid/side
    double sampleRate = 48000.0;
};

// The hall as a streaming processor: lines, filters and LFO phase
// carried across blocks, so any block partitioning emits the same
// bits. process() is in place and same-length — the wet path is the
// predelayed mono sum, the dry path is not delayed. The tail is
// emitted by processing silence: feed tailSamples() of zeros after
// the input ends. Zero latency — the predelay is the effect, not the
// pipeline.
class Hall
{
public:
    Hall (const HallSettings& settings, size_t numChannels);
    void process (std::vector<std::vector<float>>& block);
    // Where this chain starts rendering on the unwrapped input
    // timeline (reverbs.md decision 4): zero offline and at load, the
    // warmup start at a locate.
    void startAt (long long sample) { clock = sample; }
    // Predelay plus the longest band's tail: decay·max(1, decay_low,
    // decay_high) — whichever band rings longest governs, which is
    // the compiler's arithmetic exactly (decision 5).
    long tailSamples() const { return (long) (predelaySamples + tailLength); }
    long latencySamples() const { return 0; }

private:
    struct Allpass
    {
        std::vector<double> buffer;
        size_t at = 0;
        double gain = 0.0;
    };
    struct Line
    {
        std::vector<double> buffer; // length + max excursion + 2
        size_t at = 0;
        long length = 0; // the prime nominal delay
        double lfoRate = 1.0; // Hz
        double midGain = 0.0; // per-pass gain for the mid T60
        double lowGain = 0.0; // extra DC gain toward the low T60
        double highGain = 0.0; // extra Nyquist gain toward the high T60
        double lowStates[3] = { 0.0, 0.0, 0.0 }; // the low tilt's pole cascade
        double highStates[3] = { 0.0, 0.0, 0.0 }; // the high tilt's pole cascade
    };

    static double readAgo (const std::vector<double>& buffer, size_t at, long ago);

    std::vector<double> predelayLine; // mono ring of predelaySamples zeros
    size_t predelayAt = 0;
    std::vector<Allpass> inputDiffusers; // four in series
    Line lines[8];
    double lowCoeff = 0.0; // one-pole coefficient at the low crossover
    double highCoeff = 0.0; // one-pole coefficient at the high crossover

    double mix = 0.3;
    double width = 1.0;
    double excursionDepth = 0.0; // samples, fractional
    double sampleRate = 48000.0;
    size_t numChannels = 0;
    size_t predelaySamples = 0;
    size_t tailLength = 0;
    long long clock = 0; // unwrapped input-timeline index
};

// Output is input length + predelay + tail, so this returns new
// buffers rather than working in place.
std::vector<std::vector<float>> hall (const std::vector<std::vector<float>>& channels,
                                      const HallSettings& settings);

} // namespace field::dsp
