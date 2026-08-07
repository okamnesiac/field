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
} // namespace

std::vector<std::vector<float>> reverb (const std::vector<std::vector<float>>& channels,
                                        const ReverbSettings& settings)
{
    const size_t frames = channels.empty() ? 0 : channels[0].size();
    const size_t predelay
        = (size_t) std::max (0L, std::lround ((settings.predelayMs / 1000.0) * settings.sampleRate));
    const size_t tail
        = (size_t) std::max (0L, std::lround (settings.decaySeconds * settings.sampleRate));
    const size_t total = frames + predelay + tail;

    std::vector<std::vector<float>> result;
    result.reserve (channels.size());

    for (size_t channelIndex = 0; channelIndex < channels.size(); ++channelIndex)
    {
        const auto& dry = channels[channelIndex];
        const int spread = channelIndex == 0 ? 0 : stereoSpread;

        std::vector<Comb> combs;
        for (const int tuning : combTunings)
        {
            const int length = scaled (tuning, settings.sampleRate, spread);
            Comb comb;
            comb.buffer.assign ((size_t) length, 0.0);
            // T60: feedback^(T60·rate/length) = 10^(−3) → per-pass feedback.
            comb.feedback
                = std::pow (10.0, (-3.0 * length) / (settings.decaySeconds * settings.sampleRate));
            combs.push_back (std::move (comb));
        }

        std::vector<Allpass> allpasses;
        for (const int tuning : allpassTunings)
        {
            Allpass allpass;
            allpass.buffer.assign ((size_t) scaled (tuning, settings.sampleRate, spread), 0.0);
            allpasses.push_back (std::move (allpass));
        }

        std::vector<float> out (total, 0.0f);
        for (size_t i = 0; i < total; ++i)
        {
            const double input
                = (i >= predelay && i - predelay < frames) ? (double) dry[i - predelay] : 0.0;

            double wet = 0.0;
            for (auto& comb : combs)
            {
                const double read = comb.buffer[comb.at];
                wet += read;
                comb.filtered = read * (1.0 - settings.damping) + comb.filtered * settings.damping;
                comb.buffer[comb.at] = input + comb.filtered * comb.feedback;
                // The port note in render-pipeline.md §5: compare-and-reset
                // where the reference takes a modulo, twelve times per
                // sample per channel.
                if (++comb.at >= comb.buffer.size())
                    comb.at = 0;
            }
            wet /= (double) combs.size();

            for (auto& allpass : allpasses)
            {
                const double read = allpass.buffer[allpass.at];
                const double fed = wet + read * 0.5;
                allpass.buffer[allpass.at] = fed;
                wet = read - fed * 0.5; // canonical Schroeder, not JUCE's read − x
                if (++allpass.at >= allpass.buffer.size())
                    allpass.at = 0;
            }

            const double dryHere = i < frames ? (double) dry[i] : 0.0;
            out[i] = (float) (dryHere * (1.0 - settings.mix) + wet * settings.mix);
        }
        result.push_back (std::move (out));
    }

    return result;
}

} // namespace field::dsp
