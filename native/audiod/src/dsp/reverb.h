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

// Output is input length + predelay + tail (to −60 dB, i.e. the T60), so
// this returns new buffers rather than working in place.
std::vector<std::vector<float>> reverb (const std::vector<std::vector<float>>& channels,
                                        const ReverbSettings& settings);

} // namespace field::dsp
