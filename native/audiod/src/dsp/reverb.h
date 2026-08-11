#pragma once

#include <vector>

// Freeverb (Schroeder–Moorer) — the C++ side of the port, transliterated
// from src/audio/reverb.ts. Eight parallel feedback combs with damping in
// the loop, four series allpasses, the right channel's delays spread by a
// fixed offset for width. Deterministic, no randomness anywhere.
//
// Two things here diverge from juce::Reverb deliberately, and
// render-pipeline.md §2.4 says the port must carry both on purpose:
//
//   - Comb feedback derives from the requested decay (T60) per comb
//     length, so `decay` means seconds-to-−60 dB rather than an abstract
//     room knob. JUCE applies one roomSize-derived feedback to all eight,
//     so each decays at a different real rate.
//   - The allpass is the canonical Schroeder form, `read − 0.5·(x +
//     0.5·read)`. JUCE returns `read − x`, Jezar's Freeverb variant, which
//     is not a true allpass. The property test measuring comb-bank energy
//     is what holds this in place once reverb.ts is deleted.
//
// And one that is easy to miss: the scaled delay lengths ROUND, where
// JUCE truncates in integer arithmetic. At 48 kHz that is one sample
// different on seven of the twelve lines per channel.

namespace field::dsp
{

struct ReverbSettings
{
    double mix = 0.3; // 0 dry … 1 wet
    double decaySeconds = 2.0; // T60
    double predelayMs = 0.0;
    double damping = 0.5; // 0 bright … 1 dark
    double sampleRate = 48000.0;
};

// The reverb as a streaming processor: comb, allpass, and predelay state
// carried across blocks, so any block partitioning emits the same bits.
// process() is in place and same-length — the wet path is the predelayed
// input, the dry path is not delayed, exactly as the whole-buffer form
// has always mixed them. The tail is emitted by processing silence:
// feed tailSamples() of zeros after the input ends. Zero latency — the
// predelay is the effect, not the pipeline.
class Reverb
{
public:
    Reverb (const ReverbSettings& settings, size_t numChannels);
    void process (std::vector<std::vector<float>>& block);
    // Predelay plus the T60 tail: how much silence to feed (and keep)
    // after the last input sample to hear the effect out.
    long tailSamples() const { return (long) (predelaySamples + tailLength); }
    long latencySamples() const { return 0; }

private:
    struct Comb
    {
        std::vector<double> buffer;
        size_t at = 0;
        double feedback = 0.0;
        double filtered = 0.0; // one-pole damping state inside the loop
    };
    struct Allpass
    {
        std::vector<double> buffer;
        size_t at = 0;
    };
    struct Channel
    {
        std::vector<Comb> combs;
        std::vector<Allpass> allpasses;
        std::vector<double> predelayLine; // ring of predelaySamples zeros
        size_t predelayAt = 0;
    };
    std::vector<Channel> channels;
    double mix = 0.3;
    double damping = 0.5;
    size_t predelaySamples = 0;
    size_t tailLength = 0;
};

// Output is input length + predelay + tail (to −60 dB, i.e. the T60), so
// this returns new buffers rather than working in place.
std::vector<std::vector<float>> reverb (const std::vector<std::vector<float>>& channels,
                                        const ReverbSettings& settings);

} // namespace field::dsp
