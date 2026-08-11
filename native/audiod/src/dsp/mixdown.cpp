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
        // Belt to the validator's braces, and unlike most such pairs this
        // one earns its place: `start` and `duration` index the output
        // buffer, so a negative reaching here is not a wrong render but a
        // write outside the allocation. plan.cpp rejects it, and if a
        // future parser change stops doing so, the consequence should be
        // an error rather than memory corruption (#54 review, found with
        // AddressSanitizer).
        if (clip.start < 0 || clip.duration < 0)
            throw std::runtime_error ("clip has negative start or duration");
        const auto& srcL = sources[(size_t) clip.input][0];
        const auto& srcR = rightOf (sources[(size_t) clip.input]);
        const double gain = std::pow (10.0, clip.gainDb / 20.0);
        // Same law the mix faders use, one function, so a placement and a
        // fader cannot drift into two different centres.
        double balanceL = 1.0, balanceR = 1.0;
        balanceGains (clip.pan, balanceL, balanceR);

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
            left[at] = (float) ((double) left[at] + (double) srcL[(size_t) s] * g * balanceL);
            right[at] = (float) ((double) right[at] + (double) srcR[(size_t) s] * g * balanceR);
        }
    }

    return out;
}

void balanceGains (double pan, double& left, double& right)
{
    left = pan > 0.0 ? std::cos ((pan * M_PI) / 2.0) : 1.0;
    right = pan < 0.0 ? std::cos ((-pan * M_PI) / 2.0) : 1.0;
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
