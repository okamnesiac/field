#include "mixdown.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

namespace field::dsp
{
namespace
{
// Mono content plays on both stem channels, as the reference does.
const std::vector<float>& rightOf (const std::vector<std::vector<float>>& source)
{
    return source.size() > 1 ? source[1] : source[0];
}
} // namespace

std::vector<std::vector<float>> sumClips (const std::vector<std::vector<std::vector<float>>>& sources,
                                          const std::vector<PlacedClip>& clips)
{
    long length = 0;
    for (const auto& clip : clips)
        length = std::max (length, clip.start + clip.duration);

    std::vector<std::vector<float>> out (2, std::vector<float> ((size_t) length, 0.0f));
    auto& left = out[0];
    auto& right = out[1];

    for (const auto& clip : clips)
    {
        // A clip naming an input that is not there is a plan the daemon
        // cannot render, not a clip to leave out. Skipping it would write
        // plausible audio under an action key that still describes the
        // omitted clip — the fail-closed rule from decision 6, which the
        // unknown-effect and unknown-band-type checks already follow.
        //
        // Note this is a different animal from the `continue` a few lines
        // down: *that* one is the declared behaviour of slip (reads
        // outside a source are silence, so slipping never errors), and
        // its legitimacy is precisely what made this one look normal
        // while it was being written.
        if (clip.input < 0 || (size_t) clip.input >= sources.size())
            throw std::runtime_error ("clip names input " + std::to_string (clip.input)
                                      + " but the plan has " + std::to_string (sources.size()));
        if (sources[(size_t) clip.input].empty())
            throw std::runtime_error ("clip input " + std::to_string (clip.input)
                                      + " has no channels");
        const auto& srcL = sources[(size_t) clip.input][0];
        const auto& srcR = rightOf (sources[(size_t) clip.input]);
        const double gain = std::pow (10.0, clip.gainDb / 20.0);

        for (long i = 0; i < clip.duration; ++i)
        {
            const long s = clip.readOffset + i;
            // Declared behaviour, not a guard: reads outside the source are
            // silence, which is what lets slip run past either edge
            // without erroring (project-core.md §3.2).
            if (s < 0 || (size_t) s >= srcL.size())
                continue;
            double g = gain;
            if ((double) i < clip.fadeIn)
                g *= (double) i / clip.fadeIn;
            const double fromEnd = (double) (clip.duration - 1 - i);
            if (fromEnd < clip.fadeOut)
                g *= fromEnd / clip.fadeOut;
            const size_t at = (size_t) (clip.start + i);
            left[at] = (float) ((double) left[at] + (double) srcL[(size_t) s] * g);
            right[at] = (float) ((double) right[at] + (double) srcR[(size_t) s] * g);
        }
    }

    return out;
}

void balanceGains (double pan, double& left, double& right)
{
    left = pan > 0.0 ? std::cos ((pan * M_PI) / 2.0) : 1.0;
    right = pan < 0.0 ? std::cos ((-pan * M_PI) / 2.0) : 1.0;
}

std::vector<std::vector<float>> sumStems (const std::vector<std::vector<std::vector<float>>>& stems,
                                          const std::vector<Fader>& faders)
{
    size_t length = 0;
    for (const auto& stem : stems)
        if (! stem.empty())
            length = std::max (length, stem[0].size());

    std::vector<std::vector<float>> out (2, std::vector<float> (length, 0.0f));
    auto& left = out[0];
    auto& right = out[1];

    for (size_t i = 0; i < stems.size(); ++i)
    {
        // Same rule: a stem with no channels, or missing its fader, is a
        // malformed plan rather than a track to drop from the mix.
        if (i >= faders.size())
            throw std::runtime_error ("mix input " + std::to_string (i) + " has no fader");
        if (stems[i].empty())
            throw std::runtime_error ("mix input " + std::to_string (i) + " has no channels");
        const auto& srcL = stems[i][0];
        const auto& srcR = rightOf (stems[i]);
        const double gain = std::pow (10.0, faders[i].gainDb / 20.0);
        double balanceL = 1.0, balanceR = 1.0;
        balanceGains (faders[i].pan, balanceL, balanceR);
        const double gL = gain * balanceL;
        const double gR = gain * balanceR;

        for (size_t at = 0; at < srcL.size(); ++at)
        {
            left[at] = (float) ((double) left[at] + (double) srcL[at] * gL);
            right[at] = (float) ((double) right[at] + (double) srcR[at] * gR);
        }
    }

    return out;
}

void applyDeclaredLength (std::vector<std::vector<float>>& channels, long declared, bool loop)
{
    if (declared < 0)
        return;
    for (auto& channel : channels)
    {
        std::vector<float> out ((size_t) declared, 0.0f);
        const size_t copy = std::min ((size_t) declared, channel.size());
        std::copy (channel.begin(), channel.begin() + (long) copy, out.begin());
        // `declared > 0` guards the stride: folding at zero would advance
        // `from` by nothing and spin forever. A zero-length declaration is
        // degenerate rather than impossible, and a hang is the worst way
        // to find that out.
        if (loop && declared > 0)
        {
            for (size_t from = (size_t) declared; from < channel.size(); from += (size_t) declared)
            {
                const size_t n = std::min ((size_t) declared, channel.size() - from);
                for (size_t i = 0; i < n; ++i)
                    out[i] = (float) ((double) out[i] + (double) channel[from + i]);
            }
        }
        channel = std::move (out);
    }
}

} // namespace field::dsp
