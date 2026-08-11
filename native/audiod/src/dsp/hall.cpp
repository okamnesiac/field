#include "hall.h"

#include <algorithm>
#include <cmath>

namespace field::dsp
{
namespace
{
constexpr double pi = 3.14159265358979323846;

// Base line lengths at 48 kHz and size 1 — a ~35–94 ms spread. These
// are already prime, but the property that matters survives scaling
// only because nearestPrime below re-snaps whatever `size` and the
// session rate produce.
constexpr int lineBaseLengths[8] = { 1697, 1999, 2311, 2677, 3109, 3581, 4127, 4507 };
constexpr double lineReferenceRate = 48000.0;

// The input diffusers: the plate's stage shape with this hall's own
// prime lengths (all ≤ 401 at 48 kHz, so the 0.93 diffusion cap keeps
// their ring inside the 1 s decay floor, the same arithmetic as the
// plate's cap).
constexpr int diffuserBaseLengths[4] = { 113, 173, 293, 401 };

// The orthogonal ± output tap pair: rows of a Hadamard-style matrix,
// so left and right hear uncorrelated mixtures of the same lines.
constexpr double tapLeft[8] = { 1, -1, 1, -1, 1, -1, 1, -1 };
constexpr double tapRight[8] = { 1, 1, -1, -1, 1, 1, -1, -1 };
constexpr double tapScale = 0.35355339059327373; // 1/√8: unity-power taps

long nearestPrime (long n)
{
    const auto isPrime = [] (long candidate)
    {
        if (candidate < 2)
            return false;
        for (long d = 2; d * d <= candidate; ++d)
            if (candidate % d == 0)
                return false;
        return true;
    };
    for (long offset = 0;; ++offset)
    {
        if (isPrime (n + offset))
            return n + offset;
        if (n - offset > 1 && isPrime (n - offset))
            return n - offset;
    }
}

double allpassStep (double input, double read, double gain, double& fed)
{
    fed = input + read * gain;
    return read - fed * gain;
}
} // namespace

double Hall::readAgo (const std::vector<double>& buffer, size_t at, long ago)
{
    const long size = (long) buffer.size();
    long index = (long) at - ago;
    while (index < 0)
        index += size;
    return buffer[(size_t) index];
}

Hall::Hall (const HallSettings& settings, size_t channels)
    : mix (settings.mix), width (settings.width), sampleRate (settings.sampleRate),
      numChannels (channels)
{
    predelaySamples
        = (size_t) std::max (0L, std::lround ((settings.predelayMs / 1000.0) * sampleRate));
    const double longest = settings.decaySeconds
                           * std::max ({ 1.0, settings.decayLow, settings.decayHigh });
    tailLength = (size_t) std::max (0L, std::lround (longest * sampleRate));
    predelayLine.assign (predelaySamples, 0.0);

    for (size_t k = 0; k < 4; ++k)
    {
        Allpass apf;
        const long length = std::max (1L, std::lround ((diffuserBaseLengths[k] * sampleRate)
                                                       / lineReferenceRate));
        apf.buffer.assign ((size_t) length, 0.0);
        // Negative like the plate's input stage, and the same 5/6
        // ratio between the pairs.
        apf.gain = -(k < 2 ? settings.diffusion : settings.diffusion * (5.0 / 6.0));
        inputDiffusers.push_back (std::move (apf));
    }

    excursionDepth = settings.modulation * (8.0 * sampleRate) / lineReferenceRate;

    // One-pole coefficients for the two tilt stages; state = coeff·
    // state + (1−coeff)·x is a lowpass whose −3 dB point sits at the
    // crossover.
    lowCoeff = std::exp (-2.0 * pi * hallLowCrossoverHz / sampleRate);
    highCoeff = std::exp (-2.0 * pi * hallHighCrossoverHz / sampleRate);

    for (int k = 0; k < 8; ++k)
    {
        Line& line = lines[k];
        line.length = nearestPrime (std::max (
            2L, std::lround ((lineBaseLengths[k] * settings.size * sampleRate)
                             / lineReferenceRate)));
        line.buffer.assign ((size_t) (line.length + (long) excursionDepth + 2), 0.0);
        line.lfoRate = hallLfoRates[k];
        // Per-band per-pass gains from this line's actual length: the
        // mid gain hits the mid T60 exactly; the low and high tilts
        // multiply it toward their bands' targets at DC and Nyquist.
        const auto passGain = [&] (double t60)
        { return std::pow (10.0, (-3.0 * (double) line.length) / (t60 * sampleRate)); };
        line.midGain = passGain (settings.decaySeconds);
        line.lowGain = passGain (settings.decaySeconds * settings.decayLow) / line.midGain;
        line.highGain = passGain (settings.decaySeconds * settings.decayHigh) / line.midGain;
    }
}

void Hall::process (std::vector<std::vector<float>>& block)
{
    const size_t frames = block.empty() ? 0 : block[0].size();
    for (size_t i = 0; i < frames; ++i)
    {
        double dry[2] = { 0.0, 0.0 };
        double input = 0.0;
        for (size_t c = 0; c < numChannels && c < block.size(); ++c)
        {
            dry[c < 2 ? c : c % 2] = (double) block[c][i];
            input += (double) block[c][i];
        }
        input /= (double) std::max<size_t> (1, std::min (numChannels, block.size()));

        if (predelaySamples > 0)
        {
            const double delayed = predelayLine[predelayAt];
            predelayLine[predelayAt] = input;
            if (++predelayAt >= predelaySamples)
                predelayAt = 0;
            input = delayed;
        }

        double diffused = input;
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

        // Read all eight lines (modulated, absorbed), then reflect:
        // the Householder feedback wants the whole vector before any
        // line takes its next input.
        const double seconds = (double) clock / sampleRate;
        double read[8];
        double sum = 0.0;
        for (int k = 0; k < 8; ++k)
        {
            Line& line = lines[k];
            const double sweep = excursionDepth * 0.5
                                 * (1.0 + std::sin (2.0 * pi * line.lfoRate * seconds));
            const double ago = (double) line.length + sweep;
            const long whole = (long) ago;
            const double frac = ago - (double) whole;
            const double a = readAgo (line.buffer, line.at, whole);
            const double b = readAgo (line.buffer, line.at, whole + 1);
            double v = a + frac * (b - a);

            // Absorption: the mid-band per-pass gain, then the two
            // tilt stages pulling DC toward the low band's target and
            // Nyquist toward the high band's, each blending through
            // its third-order pole cascade (see the header on why one
            // pole is not enough).
            v *= line.midGain;
            double stage = v;
            for (double& state : line.lowStates)
            {
                state = lowCoeff * state + (1.0 - lowCoeff) * stage;
                stage = state;
            }
            v += (line.lowGain - 1.0) * line.lowStates[2];
            stage = v;
            for (double& state : line.highStates)
            {
                state = highCoeff * state + (1.0 - highCoeff) * stage;
                stage = state;
            }
            v = line.highGain * v + (1.0 - line.highGain) * line.highStates[2];

            read[k] = v;
            sum += v;
        }

        // Householder: y = x − 2·mean(x), then each line takes its
        // reflected value plus the diffused input.
        const double reflect = 2.0 * sum / 8.0;
        double wetL = 0.0;
        double wetR = 0.0;
        for (int k = 0; k < 8; ++k)
        {
            Line& line = lines[k];
            line.buffer[line.at] = read[k] - reflect + diffused;
            if (++line.at >= line.buffer.size())
                line.at = 0;
            wetL += tapLeft[k] * read[k];
            wetR += tapRight[k] * read[k];
        }
        wetL *= tapScale;
        wetR *= tapScale;

        // width blends mid/side: 0 collapses to the (correlated) mid,
        // 1 keeps the taps' full decorrelation.
        const double midSignal = 0.5 * (wetL + wetR);
        const double sideSignal = 0.5 * (wetL - wetR);
        const double outL = midSignal + width * sideSignal;
        const double outR = midSignal - width * sideSignal;

        for (size_t c = 0; c < numChannels && c < block.size(); ++c)
        {
            const double w = numChannels < 2 ? midSignal : (c % 2 == 0 ? outL : outR);
            block[c][i] = (float) (dry[c < 2 ? c : c % 2] * (1.0 - mix) + w * mix);
        }
        ++clock;
    }
}

std::vector<std::vector<float>> hall (const std::vector<std::vector<float>>& channels,
                                      const HallSettings& settings)
{
    const size_t frames = channels.empty() ? 0 : channels[0].size();
    Hall processor (settings, channels.size());
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
