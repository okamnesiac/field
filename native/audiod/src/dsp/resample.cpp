#include "resample.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <stdexcept>
#include <string>

namespace field::dsp
{
namespace
{

// Design point. 128 taps per phase puts the transition band a little over
// 2 kHz wide at 44.1↔48 with 100 dB of stopband, which places the
// passband edge near 20.9 kHz — transparent, and affordable because this
// runs once per source (decision 9).
constexpr int tapsPerPhase = 128;
constexpr double stopbandDb = 100.0;

// Modified Bessel function of the first kind, order zero, by its series.
// Written out rather than taken from a library because it has to give the
// same bits everywhere: the terms are products and quotients only, no
// transcendental calls, and the loop stops on a relative bound so the
// iteration count depends on the value rather than on the platform.
double besselI0 (double x)
{
    double sum = 1.0;
    double term = 1.0;
    const double half = x / 2.0;
    for (int k = 1; k < 200; ++k)
    {
        term *= (half / (double) k) * (half / (double) k);
        sum += term;
        if (term < sum * 1e-17)
            break;
    }
    return sum;
}

double sinc (double x)
{
    if (x == 0.0)
        return 1.0;
    const double pix = M_PI * x;
    return std::sin (pix) / pix;
}

// The polyphase prototype, laid out as `phases` rows of `tapsPerPhase`.
// Row p holds h[i*L + p], which is the order the inner loop reads.
std::vector<double> designPrototype (long phases, double inRate, double outRate)
{
    const long taps = (long) tapsPerPhase;
    const long length = taps * phases;
    const double interpolatedRate = inRate * (double) phases;
    const double lowerNyquist = 0.5 * std::min (inRate, outRate);

    // Kaiser: beta from the stopband, transition width from the length.
    // Both are the standard design formulas; the property tests measure
    // what actually comes out rather than trusting them.
    const double beta = 0.1102 * (stopbandDb - 8.7);
    const double transitionHz =
        ((stopbandDb - 8.0) / (2.285 * 2.0 * M_PI * (double) length)) * interpolatedRate;
    // Stopband edge at the lower Nyquist, so the −6 dB point sits half a
    // transition below it. Clamped in case a pathological ratio makes the
    // transition wider than the passband itself.
    const double cutoffHz = std::max (lowerNyquist - transitionHz / 2.0, lowerNyquist * 0.5);
    const double cutoff = cutoffHz / interpolatedRate; // cycles/sample

    const double centre = ((double) length - 1.0) / 2.0;
    const double i0beta = besselI0 (beta);

    std::vector<double> rows ((size_t) length, 0.0);
    for (long k = 0; k < length; ++k)
    {
        const double offset = (double) k - centre;
        const double ratio = offset / centre;
        const double window = besselI0 (beta * std::sqrt (std::max (0.0, 1.0 - ratio * ratio))) / i0beta;
        // ×L compensates the zero-stuffing the polyphase form implies.
        const double h = 2.0 * cutoff * sinc (2.0 * cutoff * offset) * window * (double) phases;
        const long phase = k % phases;
        const long tap = k / phases;
        rows[(size_t) (phase * taps + tap)] = h;
    }
    return rows;
}

// A specified 64-bit PRNG (splitmix64) and a specified mapping to [0,1).
// Both written out for the reason decision 10 gives: the dither has to be
// the same sequence on every platform or the artifacts are not.
inline uint64_t nextState (uint64_t& state)
{
    state += 0x9E3779B97F4A7C15ull;
    uint64_t z = state;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

// Top 53 bits into [0,1), the usual exact construction.
inline double nextUnit (uint64_t& state)
{
    return (double) (nextState (state) >> 11) * (1.0 / 9007199254740992.0);
}

} // namespace

Ratio ratioFor (double inRate, double outRate)
{
    const long in = (long) std::llround (inRate);
    const long out = (long) std::llround (outRate);
    if (in <= 0 || out <= 0)
        throw std::runtime_error ("resample: rates must be positive");
    const long divisor = std::gcd (in, out);
    return { out / divisor, in / divisor };
}

std::vector<std::vector<float>> resample (const std::vector<std::vector<float>>& channels,
                                          double inRate,
                                          double outRate)
{
    const Ratio ratio = ratioFor (inRate, outRate);
    const long phases = ratio.phases;
    const long stride = ratio.stride;

    // A 1:1 ratio is not a conversion. Returning the input verbatim keeps
    // a bit-depth-only normalize from running a filter over material that
    // did not ask for one — and asking the reduced ratio, rather than
    // comparing the rates as doubles, is both exact and the same question.
    if (phases == 1 && stride == 1)
        return channels;

    const long taps = (long) tapsPerPhase;
    const std::vector<double> rows = designPrototype (phases, inRate, outRate);

    // The prototype's group delay is (N−1)/2 at the interpolated rate,
    // which is T/2 input samples less 1/(2L) of one. Shifting the read by
    // the integer part leaves a sub-sample offset far below the
    // resampler's own passband ripple, and taking it out exactly would
    // need an asymmetric — so non-linear-phase — prototype.
    const long delay = taps / 2;

    std::vector<std::vector<float>> out;
    out.reserve (channels.size());

    for (const auto& channel : channels)
    {
        const long inN = (long) channel.size();
        // Round rather than floor, and never round a non-empty source
        // away. Flooring turned a two-frame 96 kHz file into zero frames
        // at 44.1 kHz — a short one-shot vanishing entirely under an
        // action key that said otherwise, where afconvert produced one
        // frame (#57 review). Integer arithmetic so the rule is exact
        // rather than dependent on rounding mode; whole-second lengths
        // are unaffected, which is precisely why the fixtures missed it.
        const long scaled = (inN * phases + stride / 2) / stride;
        const long outN = inN > 0 ? std::max (1L, scaled) : 0L;
        std::vector<float> resampled ((size_t) std::max (0L, outN), 0.0f);

        for (long n = 0; n < outN; ++n)
        {
            const long k = n * stride;
            const long base = k / phases;
            const long phase = k % phases;
            const double* row = &rows[(size_t) (phase * taps)];

            double acc = 0.0;
            for (long i = 0; i < taps; ++i)
            {
                const long at = base - i + delay;
                // Outside the source is silence, as everywhere else in
                // this directory.
                if (at >= 0 && at < inN)
                    acc += row[i] * (double) channel[(size_t) at];
            }
            resampled[(size_t) n] = (float) acc;
        }
        out.push_back (std::move (resampled));
    }

    return out;
}

void ditherTo (std::vector<std::vector<float>>& channels, int bitDepth)
{
    // 32 is written as integer PCM like the others, but undithered, and
    // decision 10 scopes the dither to 16 and 24 for a reason worth
    // stating: the step at 32-bit sits about 186 dB below full scale,
    // finer than the float32 samples feeding it can resolve except at
    // the very bottom of the range. Dither there would add noise without
    // masking a correlated artefact anyone could measure.
    if (bitDepth == 32)
        return;
    if (bitDepth != 16 && bitDepth != 24)
        throw std::runtime_error ("dither: unsupported bit depth " + std::to_string (bitDepth));

    const double scale = std::pow (2.0, (double) (bitDepth - 1));
    const double top = scale - 1.0;
    uint64_t state = 0x6669656C64646974ull; // "fielddit"

    for (auto& channel : channels)
    {
        for (auto& sample : channel)
        {
            // TPDF: two independent uniforms summed spans ±1 LSB, with a
            // triangular density. One uniform (RPDF) would leave the noise
            // floor modulated by the signal, which is the artefact dither
            // exists to remove.
            const double tpdf = nextUnit (state) - nextUnit (state);
            const double scaled = (double) sample * scale + tpdf;
            const double quantized = std::max (-scale, std::min (top, std::floor (scaled + 0.5)));
            sample = (float) (quantized / scale);
        }
    }
}

} // namespace field::dsp
