#include "click.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace field
{
namespace
{
// click.ts's recipe, kept so the metronome sounds as it did.
constexpr double clickSeconds = 0.015;
constexpr double clickDecaySeconds = 0.004;
constexpr float clickGain = 0.4f;
constexpr double accentHz = 1568.0; // G6 on the downbeat
constexpr double beatHz = 1046.5; // C6 elsewhere
} // namespace

void Click::setSchedule (const juce::var& schedule)
{
    const auto rateVar = schedule.getProperty ("rate", juce::var());
    if (! rateVar.isInt() && ! rateVar.isInt64() && ! rateVar.isDouble())
        throw std::runtime_error ("click needs a rate");
    const auto newRate = (double) rateVar;
    if (newRate <= 0.0)
        throw std::runtime_error ("click rate must be positive");
    const auto* list = schedule.getProperty ("ticks", juce::var()).getArray();
    if (list == nullptr)
        throw std::runtime_error ("click needs a ticks array");
    std::vector<ClickTick> parsed;
    parsed.reserve ((size_t) list->size());
    for (const auto& item : *list)
    {
        const auto sample = item.getProperty ("sample", juce::var());
        if (! sample.isInt() && ! sample.isInt64() && ! sample.isDouble())
            throw std::runtime_error ("each tick needs a sample");
        if ((double) sample < 0.0)
            throw std::runtime_error ("a tick's sample must be non-negative");
        parsed.push_back ({ (juce::int64) (double) sample, (bool) item.getProperty ("accent", false) });
    }
    std::sort (parsed.begin(), parsed.end(), [] (const ClickTick& a, const ClickTick& b)
               { return a.sample < b.sample; });
    const juce::ScopedLock guard (lock);
    ticks = std::move (parsed);
    rate = newRate;
}

void Click::clear()
{
    const juce::ScopedLock guard (lock);
    ticks.clear();
    for (auto& voice : voices)
        voice.active = false;
}

int Click::tickCount() const
{
    const juce::ScopedLock guard (lock);
    return (int) ticks.size();
}

void Click::render (juce::int64 position, double deviceRate, float* const* out, int numChannels, int n) noexcept
{
    const juce::ScopedTryLock guard (lock);
    if (! guard.isLocked() || (ticks.empty() && std::none_of (std::begin (voices), std::end (voices),
                                                              [] (const Voice& v) { return v.active; })))
        return;
    if (position >= 0 && ! ticks.empty() && rate > 0.0 && deviceRate > 0.0)
    {
        // This block in the schedule's own samples, then each tick's
        // offset into the block in device frames.
        const double scale = deviceRate / rate;
        const juce::int64 blockStart = position;
        const juce::int64 blockEnd = position + (juce::int64) std::ceil ((double) n / scale);
        auto it = std::lower_bound (ticks.begin(), ticks.end(), blockStart,
                                    [] (const ClickTick& t, juce::int64 s) { return t.sample < s; });
        for (; it != ticks.end() && it->sample < blockEnd; ++it)
        {
            const int offset = (int) std::llround ((double) (it->sample - blockStart) * scale);
            if (offset < 0 || offset >= n)
                continue;
            for (auto& voice : voices)
            {
                if (voice.active)
                    continue;
                voice = { it->accent ? accentHz : beatHz, 0, offset, true };
                break;
            }
        }
    }
    const int length = (int) std::lround (clickSeconds * deviceRate);
    const double decay = clickDecaySeconds * deviceRate;
    for (auto& voice : voices)
    {
        if (! voice.active)
            continue;
        for (int i = voice.startOffset; i < n && voice.elapsed < length; ++i, ++voice.elapsed)
        {
            const double t = (double) voice.elapsed;
            const float blip = (float) (std::sin (2.0 * juce::MathConstants<double>::pi * voice.hz * t / deviceRate)
                                        * std::exp (-t / decay))
                               * clickGain;
            for (int c = 0; c < numChannels; ++c)
                out[c][i] += blip;
        }
        voice.startOffset = 0;
        if (voice.elapsed >= length)
            voice.active = false;
    }
}

} // namespace field
