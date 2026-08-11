#pragma once

#include <string>
#include <vector>

// RBJ audio-EQ-cookbook biquads — the C++ side of the port recorded in
// render-pipeline.md decision 4. A faithful transliteration of
// src/audio/biquad.ts, which was itself ported from Fyra's eq.cpp, so the
// three systems agree band-for-band: bandwidth in OCTAVES via the sinh
// alpha (shelves driven from that same alpha), frequency clamped to 45% of
// Nyquist, and per-band dB summing for the response math.
//
// Kept in double throughout, as the TypeScript is. Nothing here is
// approximated for speed: this path has no deadline (mix-assembly.md §1),
// and every departure from the reference would have to be defended later
// against the property tests that measure it.

namespace field::dsp
{

// Streaming interfaces (realtime.md decision 3): every processor here is
// a stateful class whose per-sample arithmetic is the whole-buffer
// function's exactly, with filter state carried across blocks — so a
// callback processing 128 frames emits the same bits as one offline pass.
// The whole-buffer free functions are thin wrappers over these classes,
// which is what keeps the render goldens the proof that nothing moved.

struct Band
{
    std::string type; // highpass | lowshelf | bell | highshelf | lowpass
    double frequency = 1000.0;
    double gainDb = 0.0;   // bell and shelves only
    double bandwidth = 2.0; // octaves
};

struct Biquad
{
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
};

Biquad design (const Band& band, double sampleRate);

// Magnitude of one section at one frequency, in dB.
double magnitudeDb (const Biquad& biquad, double frequency, double sampleRate);

// Fyra's response-based auto-gain: composite response at 48 log-spaced
// points 20 Hz–20 kHz, converted to power and averaged (uniform log
// samples = pink-noise weighting), compensation = −10·log10(mean), clamped
// ±12 dB. Deterministic from the curve alone — EQ moves change tone, not
// level. The property test that measures this probes those same 48
// frequencies, so the constants here are load-bearing.
double autoGainDb (const std::vector<Band>& bands, double sampleRate);

// One section over one channel, in place. Transposed direct form II with
// double state, matching the reference exactly.
void processBiquad (float* samples, int numSamples, const Biquad& biquad);

// The eq insert as a streaming processor: the declared bands as one
// cascade with per-band, per-channel filter state carried across blocks,
// and the normalize compensation folded in as the final gain stage.
// Samples round to float between sections, exactly as the whole-buffer
// path always has. Zero latency; any block partitioning emits the same
// bits.
class Eq
{
public:
    Eq (const std::vector<Band>& bands, bool normalize, double sampleRate, size_t numChannels);
    // In place; block sizes are the caller's business.
    void process (std::vector<std::vector<float>>& block);
    long latencySamples() const { return 0; }

private:
    std::vector<Biquad> sections;
    bool applyGain = false;
    double gain = 1.0; // normalize compensation
    struct State
    {
        double z1 = 0.0, z2 = 0.0;
    };
    std::vector<State> states; // [section * numChannels + channel]
    size_t numChannels = 0;
};

// The whole-buffer form render.cpp's eq insert uses: one Eq over the
// entire signal.
void eq (std::vector<std::vector<float>>& channels,
         const std::vector<Band>& bands,
         bool normalize,
         double sampleRate);

} // namespace field::dsp
