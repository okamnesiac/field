#include "limiter.h"

#include <algorithm>
#include <cmath>

namespace field::dsp
{

void limit (std::vector<std::vector<float>>& channels, const LimiterSettings& settings)
{
    if (channels.empty())
        return;
    const size_t frames = channels[0].size();
    if (frames == 0)
        return;

    const double ceiling = std::pow (10.0, settings.ceilingDb / 20.0);

    std::vector<double> gainDb (frames, 0.0);
    for (size_t i = 0; i < frames; ++i)
    {
        double peak = 0.0;
        for (const auto& channel : channels)
            peak = std::max (peak, std::abs ((double) channel[i]));
        gainDb[i] = peak > ceiling ? 20.0 * std::log10 (ceiling / peak) : 0.0;
    }

    // dB per sample the envelope may rise while approaching a reduction
    // (attack, backward) or while recovering from one (release, forward).
    // The scale (full-scale-to-floor over the window) makes the deepest
    // plausible reduction span exactly the configured time.
    const double attackSlope
        = 60.0 / std::max (1.0, (settings.lookaheadMs / 1000.0) * settings.sampleRate);
    const double releaseSlope
        = 60.0 / std::max (1.0, (settings.releaseMs / 1000.0) * settings.sampleRate);

    // The constraint is "gain may not rise faster than the slope": each
    // sample is capped at its neighbour-toward-the-reduction plus the
    // slope, which leaves untouched audio at exactly 0 dB.
    for (size_t i = frames - 1; i-- > 0;)
    {
        const double ramp = gainDb[i + 1] + attackSlope;
        if (ramp < gainDb[i])
            gainDb[i] = ramp;
    }
    for (size_t i = 1; i < frames; ++i)
    {
        const double ramp = gainDb[i - 1] + releaseSlope;
        if (ramp < gainDb[i])
            gainDb[i] = ramp;
    }

    for (auto& channel : channels)
    {
        for (size_t i = 0; i < frames; ++i)
        {
            // The port note in render-pipeline.md §5: the reference calls
            // pow unconditionally, ~17M times on a three-minute stereo
            // mix. The slew above leaves untouched audio at *exactly*
            // 0 dB and pow(10, 0/20) is exactly 1, so this guard is an
            // identity, not an approximation — and it removes the libm
            // exposure of §4 from every sample the limiter did not touch.
            // The samples it did touch still call pow; that is chunk 6's
            // problem and is named there.
            if (gainDb[i] != 0.0)
                channel[i] = (float) ((double) channel[i] * std::pow (10.0, gainDb[i] / 20.0));
        }
    }
}

} // namespace field::dsp
