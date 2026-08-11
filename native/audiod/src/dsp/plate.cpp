#include "plate.h"

#include <algorithm>
#include <cmath>

namespace field::dsp
{
namespace
{
// The published tunings: sample counts at 29 761 Hz (Dattorro 1997,
// table 1 and figure 1), scaled to the session rate by rounding.
constexpr double referenceRate = 29761.0;
constexpr double pi = 3.14159265358979323846;
constexpr int inputDiffuserTunings[] = { 142, 107, 379, 277 };
constexpr int tankApf1Tunings[] = { 672, 908 }; // modulated, gain +0.70
constexpr int tankDelay1Tunings[] = { 4453, 4217 };
constexpr int tankApf2Tunings[] = { 1800, 2656 };
constexpr int tankDelay2Tunings[] = { 3720, 3163 };
constexpr double tankApf1Gain = 0.70; // decay diffusion 1, the sign-noted pair
constexpr double inputBandwidth = 0.9995; // the paper's input one-pole
constexpr double excursionTuning = 16.0; // max LFO sweep, samples at reference
constexpr double tapScale = 0.6; // the paper's output-tap coefficient

// The published output tap table: {branch, line, offset} where line is
// 0 = delay1, 1 = apf2's internal buffer, 2 = delay2. Table 2 verbatim
// (checked against the paper after review caught a transposed row):
//   yL = 0.6·n48_54[266] + 0.6·n48_54[2974] − 0.6·n55_59[1913]
//      + 0.6·n59_63[1996] − 0.6·n24_30[1990] − 0.6·n31_33[187]
//      − 0.6·n33_39[1066]
//   yR = 0.6·n24_30[353] + 0.6·n24_30[3627] − 0.6·n31_33[1228]
//      + 0.6·n33_39[2673] − 0.6·n48_54[2111] − 0.6·n55_59[335]
//      − 0.6·n59_63[121]
// where 24_30/31_33/33_39 are the left branch's delay1/apf2/delay2
// and 48_54/55_59/59_63 the right's.
struct Tap
{
    int branch;
    int line;
    int offset;
    double sign;
};
constexpr Tap leftTaps[] = {
    { 1, 0, 266, 1.0 },  { 1, 0, 2974, 1.0 }, { 1, 1, 1913, -1.0 }, { 1, 2, 1996, 1.0 },
    { 0, 0, 1990, -1.0 }, { 0, 1, 187, -1.0 }, { 0, 2, 1066, -1.0 },
};
constexpr Tap rightTaps[] = {
    { 0, 0, 353, 1.0 },  { 0, 0, 3627, 1.0 }, { 0, 1, 1228, -1.0 }, { 0, 2, 2673, 1.0 },
    { 1, 0, 2111, -1.0 }, { 1, 1, 335, -1.0 }, { 1, 2, 121, -1.0 },
};

// Rounds, as the Freeverb port's scaling does and for the same reason:
// truncation shifts every tap (reverb.cpp).
long scaled (double tuning, double sampleRate)
{
    return std::max (1L, std::lround ((tuning * sampleRate) / referenceRate));
}

// The canonical Schroeder allpass step shared by both diffuser kinds:
// read the delayed value, feed input + read·gain forward, emit
// read − fed·gain (reverb.cpp's form, one form everywhere).
double allpassStep (double input, double read, double gain, double& fed)
{
    fed = input + read * gain;
    return read - fed * gain;
}
} // namespace

double Plate::readAgo (const std::vector<double>& buffer, size_t at, long ago)
{
    const long size = (long) buffer.size();
    long index = (long) at - ago;
    while (index < 0)
        index += size;
    return buffer[(size_t) index];
}

Plate::Plate (const PlateSettings& settings, size_t channels)
    : mix (settings.mix), damping (settings.damping), sampleRate (settings.sampleRate),
      numChannels (channels)
{
    predelaySamples
        = (size_t) std::max (0L, std::lround ((settings.predelayMs / 1000.0) * sampleRate));
    tailLength = (size_t) std::max (0L, std::lround (settings.decaySeconds * sampleRate));
    predelayLine.assign (predelaySamples, 0.0);

    // diffusion is input diffusion 1 directly; #2 rides at the
    // published 5/6 ratio (0.750 → 0.625), so the default lands on the
    // paper's pair exactly. Negative, as figure 1 draws these — the
    // "note sign" pair below is the one lattice whose sign flips.
    for (size_t k = 0; k < 4; ++k)
    {
        Allpass apf;
        apf.buffer.assign ((size_t) scaled (inputDiffuserTunings[k], sampleRate), 0.0);
        apf.gain = -(k < 2 ? settings.diffusion : settings.diffusion * (5.0 / 6.0));
        inputDiffusers.push_back (std::move (apf));
    }

    excursionDepth = settings.modulation * (excursionTuning * sampleRate) / referenceRate;

    // T60 → per-pass feedback. One circulation of the figure-8 passes
    // the decay gain four times (after each branch's damping and at
    // each cross-feed) over the loop's effective length: the four
    // plain delays whole, the four diffusers by the measured weight
    // below — an allpass's mean group delay is its length, but the
    // tail's energy rides the low bins where it is longer, so no
    // closed form lands on the measured slope. The weight is measured:
    // least-squares dB slope over the 10–90% tail (impulse, mix 1,
    // damping 0, modulation 0, 48 kHz, decay 1/2/4 s) sits within
    // ±1.3 dB of −60 with 1.38 — the residual spread is apf2's gain
    // floating with the decay — and the property test holds it there.
    // Derived from the actual scaled lengths, so the knob stays
    // measurable at every rate.
    constexpr double diffuserLoopWeight = 1.38;
    double loop = 0.0;
    for (int b = 0; b < 2; ++b)
        loop += (double) (scaled (tankDelay1Tunings[b], sampleRate)
                          + scaled (tankDelay2Tunings[b], sampleRate))
                + diffuserLoopWeight
                      * (double) (scaled (tankApf1Tunings[b], sampleRate)
                                  + scaled (tankApf2Tunings[b], sampleRate));
    decayGain = std::pow (10.0, (-3.0 * loop) / (4.0 * settings.decaySeconds * sampleRate));
    // The paper's own rule for decay diffusion 2, drawn negative like
    // the input diffusers.
    const double apf2Gain = -std::clamp (decayGain + 0.15, 0.25, 0.50);

    for (int b = 0; b < 2; ++b)
    {
        tankApf1[b].length = scaled (tankApf1Tunings[b], sampleRate);
        tankApf1[b].buffer.assign ((size_t) (tankApf1[b].length + (long) excursionDepth + 2), 0.0);
        tankApf1[b].gain = tankApf1Gain;
        tankApf1[b].lfoRate = b == 0 ? plateLfoRateLeft : plateLfoRateRight;
        tankDelay1[b].buffer.assign ((size_t) scaled (tankDelay1Tunings[b], sampleRate), 0.0);
        tankApf2[b].buffer.assign ((size_t) scaled (tankApf2Tunings[b], sampleRate), 0.0);
        tankApf2[b].gain = apf2Gain;
        tankDelay2[b].buffer.assign ((size_t) scaled (tankDelay2Tunings[b], sampleRate), 0.0);
    }

    for (int side = 0; side < 2; ++side)
        for (int k = 0; k < 7; ++k)
            scaledTapOffsets[side][k]
                = scaled ((side == 0 ? leftTaps : rightTaps)[k].offset, sampleRate);
}

void Plate::process (std::vector<std::vector<float>>& block)
{
    const size_t frames = block.empty() ? 0 : block[0].size();
    for (size_t i = 0; i < frames; ++i)
    {
        // A plate is one sheet of metal: the tank hears the mono sum.
        double dry[2] = { 0.0, 0.0 };
        double input = 0.0;
        for (size_t c = 0; c < numChannels && c < block.size(); ++c)
        {
            dry[c < 2 ? c : c % 2] = (double) block[c][i];
            input += (double) block[c][i];
        }
        input /= (double) std::max<size_t> (1, std::min (numChannels, block.size()));

        // Predelay, then the input one-pole at the published bandwidth.
        if (predelaySamples > 0)
        {
            const double delayed = predelayLine[predelayAt];
            predelayLine[predelayAt] = input;
            if (++predelayAt >= predelaySamples)
                predelayAt = 0;
            input = delayed;
        }
        bandwidthState = input * inputBandwidth + bandwidthState * (1.0 - inputBandwidth);
        double diffused = bandwidthState;

        for (auto& apf : inputDiffusers)
        {
            const double read = apf.buffer[apf.at];
            double fed;
            const double out = allpassStep (diffused, read, apf.gain, fed);
            apf.buffer[apf.at] = fed;
            if (++apf.at >= apf.buffer.size())
                apf.at = 0;
            diffused = out;
        }

        // The figure-8: each branch sums the diffused input with the
        // other branch's delay2 output, read before either writes.
        const double cross[2] = { tankDelay2[1].buffer[tankDelay2[1].at],
                                  tankDelay2[0].buffer[tankDelay2[0].at] };
        const double seconds = (double) clock / sampleRate;

        // The published tap table, offsets scaled like the lengths.
        // Read before the tank writes, so offset k means "entered the
        // line k samples ago" exactly: an impulse reaches the first
        // tap at scaled(266) on the left, which the onset property
        // pins the way it pins Freeverb's.
        double wet[2] = { 0.0, 0.0 };
        const Tap* tables[2] = { leftTaps, rightTaps };
        for (int side = 0; side < 2; ++side)
        {
            double sum = 0.0;
            for (int k = 0; k < 7; ++k)
            {
                const Tap& tap = tables[side][k];
                const std::vector<double>* line = nullptr;
                size_t at = 0;
                if (tap.line == 0)
                {
                    line = &tankDelay1[tap.branch].buffer;
                    at = tankDelay1[tap.branch].at;
                }
                else if (tap.line == 1)
                {
                    line = &tankApf2[tap.branch].buffer;
                    at = tankApf2[tap.branch].at;
                }
                else
                {
                    line = &tankDelay2[tap.branch].buffer;
                    at = tankDelay2[tap.branch].at;
                }
                sum += tap.sign * readAgo (*line, at, scaledTapOffsets[side][k]);
            }
            wet[side] = tapScale * sum;
        }

        for (int b = 0; b < 2; ++b)
        {
            double x = diffused + decayGain * cross[b];

            // The modulated diffuser: the read point sweeps
            // [length, length + depth] on this branch's LFO, whose
            // phase is a pure function of the unwrapped clock —
            // block-invariant, and modulation 0 reads the integer
            // length exactly (bit-frozen).
            ModAllpass& m = tankApf1[b];
            const double sweep = excursionDepth * 0.5
                                 * (1.0 + std::sin (2.0 * pi * m.lfoRate * seconds));
            const double ago = (double) m.length + sweep;
            const long whole = (long) ago;
            const double frac = ago - (double) whole;
            const double a = readAgo (m.buffer, m.at, whole);
            const double bSample = readAgo (m.buffer, m.at, whole + 1);
            const double read = a + frac * (bSample - a);
            double fed;
            x = allpassStep (x, read, m.gain, fed);
            m.buffer[m.at] = fed;
            if (++m.at >= m.buffer.size())
                m.at = 0;

            Delay& d1 = tankDelay1[b];
            const double d1out = d1.buffer[d1.at];
            d1.buffer[d1.at] = x;
            if (++d1.at >= d1.buffer.size())
                d1.at = 0;

            dampState[b] = d1out * (1.0 - damping) + dampState[b] * damping;
            x = dampState[b] * decayGain;

            Allpass& a2 = tankApf2[b];
            const double a2read = a2.buffer[a2.at];
            x = allpassStep (x, a2read, a2.gain, fed);
            a2.buffer[a2.at] = fed;
            if (++a2.at >= a2.buffer.size())
                a2.at = 0;

            Delay& d2 = tankDelay2[b];
            d2.buffer[d2.at] = x;
            if (++d2.at >= d2.buffer.size())
                d2.at = 0;
        }

        for (size_t c = 0; c < numChannels && c < block.size(); ++c)
        {
            const double w = numChannels < 2 ? 0.5 * (wet[0] + wet[1]) : wet[c < 2 ? c : c % 2];
            block[c][i] = (float) (dry[c < 2 ? c : c % 2] * (1.0 - mix) + w * mix);
        }
        ++clock;
    }
}

std::vector<std::vector<float>> plate (const std::vector<std::vector<float>>& channels,
                                       const PlateSettings& settings)
{
    const size_t frames = channels.empty() ? 0 : channels[0].size();
    Plate processor (settings, channels.size());
    const size_t total = frames + (size_t) processor.tailSamples();

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
