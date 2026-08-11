#include "limiter.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace field::dsp
{

Limiter::Limiter (const LimiterSettings& settings, size_t channels) : numChannels (channels)
{
    ceiling = std::pow (10.0, settings.ceilingDb / 20.0);

    // dB per sample the envelope may rise while approaching a reduction
    // (attack, backward) or while recovering from one (release, forward).
    // The scale (full-scale-to-floor over the window) makes the deepest
    // plausible reduction span exactly the configured time.
    const double window = std::max (1.0, (settings.lookaheadMs / 1000.0) * settings.sampleRate);
    attackSlope = 60.0 / window;
    releaseSlope = 60.0 / std::max (1.0, (settings.releaseMs / 1000.0) * settings.sampleRate);

    // The pending window out-reaches the deepest ramp any float input
    // can demand: FLT_MAX over the ceiling (about 771 dB − ceilingDb) at
    // attackSlope dB per sample — so the incremental propagation sees
    // everything the whole-buffer sweep saw, for every finite input.
    const double deepest
        = 20.0 * std::log10 ((double) std::numeric_limits<float>::max()) - settings.ceilingDb;
    capacity = (size_t) std::ceil (deepest / attackSlope) + 1;
    pending.assign (channels, std::vector<float> (capacity, 0.0f));
    gainDb.assign (capacity, 0.0);
    previousOut = std::numeric_limits<double>::infinity();
}

void Limiter::push (const std::vector<std::vector<float>>& block,
                    size_t frame,
                    std::vector<std::vector<float>>& out)
{
    if (count == capacity)
        emitOldest (out);

    const size_t at = (head + count) % capacity;
    double peak = 0.0;
    for (size_t c = 0; c < numChannels; ++c)
    {
        const float sample = block[c][frame];
        pending[c][at] = sample;
        peak = std::max (peak, std::abs ((double) sample));
    }
    // An infinite sample clamps to FLT_MAX so its ramp stays inside the
    // window — the one divergence from the whole-buffer sweep, whose
    // reach on an infinite peak was the buffer itself.
    peak = std::min (peak, (double) std::numeric_limits<float>::max());
    gainDb[at] = peak > ceiling ? 20.0 * std::log10 (ceiling / peak) : 0.0;
    ++count;

    // Incremental backward propagation: the constraint is "gain may not
    // rise faster than the slope", each pending sample capped at its
    // neighbour-toward-the-reduction plus the slope. The early break is
    // exact — the invariant gain[k] ≤ gain[k+1] + slope already holds
    // behind the first sample the new arrival cannot lower.
    for (size_t j = count - 1; j-- > 0;)
    {
        const double ramp = gainDb[(head + j + 1) % capacity] + attackSlope;
        double& current = gainDb[(head + j) % capacity];
        if (ramp < current)
            current = ramp;
        else
            break;
    }
}

void Limiter::emitOldest (std::vector<std::vector<float>>& out)
{
    double gain = gainDb[head];
    // The forward half: recovery follows the release time. The first
    // emitted sample has no predecessor to recover from — previousOut
    // starts at infinity, so the constraint cannot bind.
    const double ramp = previousOut + releaseSlope;
    if (ramp < gain)
        gain = ramp;
    previousOut = gain;

    for (size_t c = 0; c < numChannels; ++c)
    {
        double sample = (double) pending[c][head];
        // The port note in render-pipeline.md §5: the reference calls
        // pow unconditionally, ~17M times on a three-minute stereo
        // mix. The slew leaves untouched audio at *exactly* 0 dB and
        // pow(10, 0/20) is exactly 1, so this guard is an identity, not
        // an approximation — and it removes the libm exposure of §4 from
        // every sample the limiter did not touch. The samples it did
        // touch still call pow; that is chunk 6's problem and is named
        // there.
        if (gain != 0.0)
            sample = sample * std::pow (10.0, gain / 20.0);
        out[c].push_back ((float) sample);
    }

    head = (head + 1) % capacity;
    --count;
}

void Limiter::process (const std::vector<std::vector<float>>& block,
                       std::vector<std::vector<float>>& out)
{
    if (block.empty() || numChannels == 0)
        return;
    const size_t frames = block[0].size();
    for (size_t i = 0; i < frames; ++i)
        push (block, i, out);
}

void Limiter::flush (std::vector<std::vector<float>>& out)
{
    while (count > 0)
        emitOldest (out);
}

void limit (std::vector<std::vector<float>>& channels, const LimiterSettings& settings)
{
    if (channels.empty())
        return;
    const size_t frames = channels[0].size();
    if (frames == 0)
        return;

    Limiter limiter (settings, channels.size());
    std::vector<std::vector<float>> out (channels.size());
    for (auto& channel : out)
        channel.reserve (frames);
    limiter.process (channels, out);
    limiter.flush (out);
    channels = std::move (out);
}

} // namespace field::dsp
