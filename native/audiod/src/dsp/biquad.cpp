#include "biquad.h"

#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>

namespace field::dsp
{

Biquad design (const Band& band, double sampleRate)
{
    // Clamped to 45% of Nyquist: a bell parked at the very top of the
    // range would otherwise produce coefficients that blow up.
    const double frequency = std::min (band.frequency, sampleRate * 0.45);
    const double w = (2.0 * std::numbers::pi * frequency) / sampleRate;
    const double sn = std::sin (w);
    const double cs = std::cos (w);
    const double A = std::pow (10.0, band.gainDb / 40.0);
    // The parity-proven form: bandwidth in octaves, with the w/sin(w)
    // correction that keeps the half-gain points 2^B apart in the digital
    // domain rather than only in the analog prototype.
    const double alpha = sn * std::sinh (((std::log (2.0) / 2.0) * band.bandwidth * w) / sn);

    // Deliberately uninitialised-looking: every branch below assigns all
    // six, and an unknown type throws rather than falling through. It used
    // to default to an identity filter, which meant a band type this
    // binary had never heard of rendered as though it were not there —
    // silently, and cached under an action key saying otherwise. That is
    // the same version skew the unknown-effect check in render.cpp exists
    // to prevent; it just was not applied one level down.
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a0 = 1.0, a1 = 0.0, a2 = 0.0;

    if (band.type == "bell")
    {
        b0 = 1.0 + alpha * A;
        b1 = -2.0 * cs;
        b2 = 1.0 - alpha * A;
        a0 = 1.0 + alpha / A;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha / A;
    }
    else if (band.type == "lowpass")
    {
        b0 = (1.0 - cs) / 2.0;
        b1 = 1.0 - cs;
        b2 = (1.0 - cs) / 2.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
    }
    else if (band.type == "highpass")
    {
        b0 = (1.0 + cs) / 2.0;
        b1 = -(1.0 + cs);
        b2 = (1.0 + cs) / 2.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cs;
        a2 = 1.0 - alpha;
    }
    else if (band.type == "lowshelf")
    {
        const double sa = 2.0 * std::sqrt (A) * alpha;
        b0 = A * (A + 1.0 - (A - 1.0) * cs + sa);
        b1 = 2.0 * A * (A - 1.0 - (A + 1.0) * cs);
        b2 = A * (A + 1.0 - (A - 1.0) * cs - sa);
        a0 = A + 1.0 + (A - 1.0) * cs + sa;
        a1 = -2.0 * (A - 1.0 + (A + 1.0) * cs);
        a2 = A + 1.0 + (A - 1.0) * cs - sa;
    }
    else if (band.type == "highshelf")
    {
        const double sa = 2.0 * std::sqrt (A) * alpha;
        b0 = A * (A + 1.0 + (A - 1.0) * cs + sa);
        b1 = -2.0 * A * (A - 1.0 + (A + 1.0) * cs);
        b2 = A * (A + 1.0 + (A - 1.0) * cs - sa);
        a0 = A + 1.0 - (A - 1.0) * cs + sa;
        a1 = 2.0 * (A - 1.0 - (A + 1.0) * cs);
        a2 = A + 1.0 - (A - 1.0) * cs - sa;
    }
    else
    {
        throw std::runtime_error ("unknown eq band type \"" + band.type + "\"");
    }

    return { b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0 };
}

double magnitudeDb (const Biquad& biquad, double frequency, double sampleRate)
{
    const double w = (2.0 * std::numbers::pi * std::min (frequency, sampleRate * 0.45)) / sampleRate;
    const double cw = std::cos (w);
    const double sw = std::sin (w);
    const double c2w = std::cos (2.0 * w);
    const double s2w = std::sin (2.0 * w);
    const double numRe = biquad.b0 + biquad.b1 * cw + biquad.b2 * c2w;
    const double numIm = -(biquad.b1 * sw + biquad.b2 * s2w);
    const double denRe = 1.0 + biquad.a1 * cw + biquad.a2 * c2w;
    const double denIm = -(biquad.a1 * sw + biquad.a2 * s2w);
    const double magnitude = std::sqrt ((numRe * numRe + numIm * numIm)
                                        / std::max (denRe * denRe + denIm * denIm, 1e-18));
    return 20.0 * std::log10 (std::max (magnitude, 1e-9));
}

double autoGainDb (const std::vector<Band>& bands, double sampleRate)
{
    constexpr int points = 48;
    double meanEnergy = 0.0;

    std::vector<Biquad> biquads;
    biquads.reserve (bands.size());
    for (const auto& band : bands)
        biquads.push_back (design (band, sampleRate));

    for (int i = 0; i < points; ++i)
    {
        const double frequency = 20.0 * std::pow (20000.0 / 20.0, (double) i / (points - 1));
        double db = 0.0;
        for (const auto& biquad : biquads)
            db += magnitudeDb (biquad, frequency, sampleRate);
        meanEnergy += std::pow (10.0, db / 10.0) / points;
    }

    const double compensation = -10.0 * std::log10 (std::max (meanEnergy, 1e-12));
    return std::max (-12.0, std::min (12.0, compensation));
}

void processBiquad (float* samples, int numSamples, const Biquad& biquad)
{
    double z1 = 0.0;
    double z2 = 0.0;
    for (int i = 0; i < numSamples; ++i)
    {
        const double x = (double) samples[i];
        const double y = biquad.b0 * x + z1;
        z1 = biquad.b1 * x - biquad.a1 * y + z2;
        z2 = biquad.b2 * x - biquad.a2 * y;
        samples[i] = (float) y;
    }
}

Eq::Eq (const std::vector<Band>& bands, bool normalize, double sampleRate, size_t channels)
    : applyGain (normalize), numChannels (channels)
{
    sections.reserve (bands.size());
    for (const auto& band : bands)
        sections.push_back (design (band, sampleRate));
    if (normalize)
        gain = std::pow (10.0, autoGainDb (bands, sampleRate) / 20.0);
    states.assign (sections.size() * channels, {});
}

void Eq::process (std::vector<std::vector<float>>& block)
{
    // Section-by-section over the block, channel inner — the same
    // per-sample sequence as processBiquad over a whole buffer, with the
    // section's state carried instead of reset.
    for (size_t s = 0; s < sections.size(); ++s)
    {
        const Biquad& biquad = sections[s];
        for (size_t c = 0; c < block.size() && c < numChannels; ++c)
        {
            State& state = states[s * numChannels + c];
            for (auto& sample : block[c])
            {
                const double x = (double) sample;
                const double y = biquad.b0 * x + state.z1;
                state.z1 = biquad.b1 * x - biquad.a1 * y + state.z2;
                state.z2 = biquad.b2 * x - biquad.a2 * y;
                sample = (float) y;
            }
        }
    }
    if (applyGain)
        for (auto& channel : block)
            for (auto& sample : channel)
                sample = (float) ((double) sample * gain);
}

void eq (std::vector<std::vector<float>>& channels,
         const std::vector<Band>& bands,
         bool normalize,
         double sampleRate)
{
    Eq processor (bands, normalize, sampleRate, channels.size());
    processor.process (channels);
}

} // namespace field::dsp
