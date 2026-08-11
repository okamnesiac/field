#include "reverb.h"

#include <algorithm>
#include <cmath>

namespace field::dsp
{
namespace
{
// Freeverb's tunings are samples at 44.1 kHz; scale to the actual rate.
constexpr int combTunings[] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
constexpr int allpassTunings[] = { 556, 441, 341, 225 };
constexpr int stereoSpread = 23;
constexpr double referenceRate = 44100.0;

// Rounds. JUCE truncates the same table in integer arithmetic, which at
// 48 kHz is one sample short on seven of the twelve lines — enough to
// shift every tap. The sample-accurate predelay-onset property is what
// locks this.
int scaled (int tuning, double sampleRate, int spread)
{
    return std::max (1, (int) std::lround (((tuning + spread) * sampleRate) / referenceRate));
}
} // namespace

Reverb::Reverb (const ReverbSettings& settings, size_t numChannels)
    : mix (settings.mix), damping (settings.damping)
{
    predelaySamples
        = (size_t) std::max (0L, std::lround ((settings.predelayMs / 1000.0) * settings.sampleRate));
    tailLength = (size_t) std::max (0L, std::lround (settings.decaySeconds * settings.sampleRate));

    channels.resize (numChannels);
    for (size_t channelIndex = 0; channelIndex < numChannels; ++channelIndex)
    {
        const int spread = channelIndex == 0 ? 0 : stereoSpread;
        Channel& state = channels[channelIndex];

        for (const int tuning : combTunings)
        {
            const int length = scaled (tuning, settings.sampleRate, spread);
            Comb comb;
            comb.buffer.assign ((size_t) length, 0.0);
            // T60: feedback^(T60·rate/length) = 10^(−3) → per-pass feedback.
            comb.feedback
                = std::pow (10.0, (-3.0 * length) / (settings.decaySeconds * settings.sampleRate));
            state.combs.push_back (std::move (comb));
        }

        for (const int tuning : allpassTunings)
        {
            Allpass allpass;
            allpass.buffer.assign ((size_t) scaled (tuning, settings.sampleRate, spread), 0.0);
            state.allpasses.push_back (std::move (allpass));
        }

        state.predelayLine.assign (predelaySamples, 0.0);
    }
}

void Reverb::process (std::vector<std::vector<float>>& block)
{
    for (size_t channelIndex = 0; channelIndex < block.size() && channelIndex < channels.size();
         ++channelIndex)
    {
        Channel& state = channels[channelIndex];
        for (auto& sample : block[channelIndex])
        {
            const double dry = (double) sample;

            // The wet path hears the input predelaySamples late; the ring
            // starts as zeros, which is the whole-buffer form's
            // before-the-predelay silence.
            double input = dry;
            if (predelaySamples > 0)
            {
                input = state.predelayLine[state.predelayAt];
                state.predelayLine[state.predelayAt] = dry;
                if (++state.predelayAt >= predelaySamples)
                    state.predelayAt = 0;
            }

            double wet = 0.0;
            for (auto& comb : state.combs)
            {
                const double read = comb.buffer[comb.at];
                wet += read;
                comb.filtered = read * (1.0 - damping) + comb.filtered * damping;
                comb.buffer[comb.at] = input + comb.filtered * comb.feedback;
                // The port note in render-pipeline.md §5: compare-and-reset
                // where the reference takes a modulo, twelve times per
                // sample per channel.
                if (++comb.at >= comb.buffer.size())
                    comb.at = 0;
            }
            wet /= (double) state.combs.size();

            for (auto& allpass : state.allpasses)
            {
                const double read = allpass.buffer[allpass.at];
                const double fed = wet + read * 0.5;
                allpass.buffer[allpass.at] = fed;
                wet = read - fed * 0.5; // canonical Schroeder, not JUCE's read − x
                if (++allpass.at >= allpass.buffer.size())
                    allpass.at = 0;
            }

            sample = (float) (dry * (1.0 - mix) + wet * mix);
        }
    }
}

std::vector<std::vector<float>> reverb (const std::vector<std::vector<float>>& channels,
                                        const ReverbSettings& settings)
{
    const size_t frames = channels.empty() ? 0 : channels[0].size();
    Reverb processor (settings, channels.size());
    const size_t total = frames + (size_t) processor.tailSamples();

    // The input padded with predelay + tail of silence, processed as one
    // block: sample for sample the loop the whole-buffer form always ran.
    std::vector<std::vector<float>> extended;
    extended.reserve (channels.size());
    for (const auto& dry : channels)
    {
        std::vector<float> padded (total, 0.0f);
        std::copy (dry.begin(), dry.end(), padded.begin());
        extended.push_back (std::move (padded));
    }
    processor.process (extended);
    return extended;
}

} // namespace field::dsp
