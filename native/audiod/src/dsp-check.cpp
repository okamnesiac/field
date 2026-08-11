// Block-size invariance for the streaming DSP classes (realtime.md
// decision 3): a stem op processing offline-sized chunks and a callback
// processing 128 frames must emit the same samples, so each processor is
// run over one deterministic signal whole and then partitioned at several
// block sizes, and every float is compared for bit equality. Equivalence
// to the *previous* whole-buffer implementations is not this program's
// job — the render goldens in src/audio/render-daemon.test.ts and the
// measurements in src/generators/effect-properties.test.ts carry that.
//
// Exit 0 and per-case "ok" lines on success; the first mismatch prints
// where and exits 1.

#include "dsp/biquad.h"
#include "dsp/hall.h"
#include "dsp/limiter.h"
#include "dsp/plate.h"
#include "dsp/resample.h"
#include "dsp/reverb.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

namespace
{
using Buffer = std::vector<std::vector<float>>;

// splitmix64, the same construction the dither uses, seeded differently.
uint64_t nextState (uint64_t& state)
{
    state += 0x9E3779B97F4A7C15ull;
    uint64_t z = state;
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
    return z ^ (z >> 31);
}

double nextUnit (uint64_t& state)
{
    return (double) (nextState (state) >> 11) * (1.0 / 9007199254740992.0);
}

// Two channels, ~one second: noise, a hot spike (real limiter depth), and
// a silence stretch (reverb and limiter recovery cross block boundaries).
Buffer testSignal (size_t frames)
{
    uint64_t state = 0x6669656C64647370ull; // "fielddsp"
    Buffer signal (2, std::vector<float> (frames, 0.0f));
    for (size_t c = 0; c < signal.size(); ++c)
        for (size_t i = 0; i < frames; ++i)
            signal[c][i] = (float) ((nextUnit (state) * 2.0 - 1.0) * 0.9);
    for (auto& channel : signal)
    {
        channel[frames / 3] = 8.0f; // ~18 dB over a −1 dB ceiling
        for (size_t i = frames / 2; i < frames / 2 + frames / 8 && i < frames; ++i)
            channel[i] = 0.0f;
        // Subnormal inputs are data (realtime.md decision 6): they must
        // stream through every processor the same way at every block size.
        channel[frames / 2 + 2] = 1e-40f;
        channel[frames / 2 + 3] = -3e-39f;
    }
    return signal;
}

bool equalBuffers (const Buffer& a, const Buffer& b, const char* what, long blockSize)
{
    if (a.size() != b.size())
    {
        std::printf ("FAIL %s block=%ld: channel count %zu vs %zu\n", what, blockSize, a.size(),
                     b.size());
        return false;
    }
    for (size_t c = 0; c < a.size(); ++c)
    {
        if (a[c].size() != b[c].size())
        {
            std::printf ("FAIL %s block=%ld: channel %zu length %zu vs %zu\n", what, blockSize, c,
                         a[c].size(), b[c].size());
            return false;
        }
        if (std::memcmp (a[c].data(), b[c].data(), a[c].size() * sizeof (float)) != 0)
        {
            for (size_t i = 0; i < a[c].size(); ++i)
                if (std::memcmp (&a[c][i], &b[c][i], sizeof (float)) != 0)
                {
                    std::printf ("FAIL %s block=%ld: channel %zu sample %zu: %.9g vs %.9g\n", what,
                                 blockSize, c, i, (double) a[c][i], (double) b[c][i]);
                    return false;
                }
        }
    }
    return true;
}

Buffer slice (const Buffer& signal, size_t from, size_t count)
{
    Buffer block (signal.size());
    for (size_t c = 0; c < signal.size(); ++c)
        block[c].assign (signal[c].begin() + (long) from, signal[c].begin() + (long) (from + count));
    return block;
}

const long blockSizes[] = { 1, 7, 128, 480, 4096 };

// Runs `partitioned` for every block size and compares against `whole`.
bool check (const char* what, const Buffer& whole, const std::function<Buffer (long)>& partitioned)
{
    for (const long blockSize : blockSizes)
    {
        if (! equalBuffers (whole, partitioned (blockSize), what, blockSize))
            return false;
        std::printf ("ok  %s block=%ld\n", what, blockSize);
    }
    return true;
}

bool checkEq (const Buffer& signal)
{
    const std::vector<field::dsp::Band> bands = {
        { "bell", 1000.0, 6.0, 1.0 },
        { "lowshelf", 120.0, -3.0, 2.0 },
        { "highpass", 40.0, 0.0, 2.0 },
    };
    const double rate = 48000.0;

    Buffer whole = signal;
    field::dsp::Eq (bands, true, rate, whole.size()).process (whole);

    return check ("eq", whole, [&] (long blockSize) {
        Buffer out (signal.size());
        field::dsp::Eq processor (bands, true, rate, signal.size());
        for (size_t at = 0; at < signal[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, signal[0].size() - at);
            Buffer block = slice (signal, at, count);
            processor.process (block);
            for (size_t c = 0; c < out.size(); ++c)
                out[c].insert (out[c].end(), block[c].begin(), block[c].end());
        }
        return out;
    });
}

bool checkReverb (const Buffer& signal)
{
    field::dsp::ReverbSettings settings;
    settings.mix = 0.4;
    settings.decaySeconds = 0.8;
    settings.predelayMs = 10.0;
    settings.damping = 0.5;
    settings.sampleRate = 48000.0;

    // The streaming contract: the tail is silence fed through, so both
    // sides process the same extended signal.
    Buffer extended = signal;
    {
        field::dsp::Reverb probe (settings, signal.size());
        for (auto& channel : extended)
            channel.resize (channel.size() + (size_t) probe.tailSamples(), 0.0f);
    }

    Buffer whole = extended;
    field::dsp::Reverb (settings, whole.size()).process (whole);

    return check ("reverb", whole, [&] (long blockSize) {
        Buffer out (extended.size());
        field::dsp::Reverb processor (settings, extended.size());
        for (size_t at = 0; at < extended[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, extended[0].size() - at);
            Buffer block = slice (extended, at, count);
            processor.process (block);
            for (size_t c = 0; c < out.size(); ++c)
                out[c].insert (out[c].end(), block[c].begin(), block[c].end());
        }
        return out;
    });
}

// Both modulation cases, deliberately (reverbs.md decision 4):
// modulation 0 is the bit-frozen fixture default, and a non-zero depth
// proves the LFO phase is a pure function of the sample counter rather
// than of the block boundaries it happens to be computed inside.
bool checkPlate (const Buffer& signal, double modulation)
{
    field::dsp::PlateSettings settings;
    settings.mix = 0.4;
    settings.decaySeconds = 1.2;
    settings.predelayMs = 10.0;
    settings.damping = 0.5;
    settings.diffusion = 0.75;
    settings.modulation = modulation;
    settings.sampleRate = 48000.0;

    Buffer extended = signal;
    {
        field::dsp::Plate probe (settings, signal.size());
        for (auto& channel : extended)
            channel.resize (channel.size() + (size_t) probe.tailSamples(), 0.0f);
    }

    Buffer whole = extended;
    field::dsp::Plate (settings, whole.size()).process (whole);

    const std::string what = "plate mod=" + std::to_string (modulation);
    return check (what.c_str(), whole, [&] (long blockSize) {
        Buffer out (extended.size());
        field::dsp::Plate processor (settings, extended.size());
        for (size_t at = 0; at < extended[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, extended[0].size() - at);
            Buffer block = slice (extended, at, count);
            processor.process (block);
            for (size_t c = 0; c < out.size(); ++c)
                out[c].insert (out[c].end(), block[c].begin(), block[c].end());
        }
        return out;
    });
}

// Same pair of modulation cases as the plate, for the same reason.
bool checkHall (const Buffer& signal, double modulation)
{
    field::dsp::HallSettings settings;
    settings.mix = 0.4;
    settings.decaySeconds = 1.2;
    settings.decayLow = 1.3;
    settings.decayHigh = 0.4;
    settings.size = 0.8;
    settings.predelayMs = 10.0;
    settings.diffusion = 0.8;
    settings.modulation = modulation;
    settings.width = 1.0;
    settings.sampleRate = 48000.0;

    Buffer extended = signal;
    {
        field::dsp::Hall probe (settings, signal.size());
        for (auto& channel : extended)
            channel.resize (channel.size() + (size_t) probe.tailSamples(), 0.0f);
    }

    Buffer whole = extended;
    field::dsp::Hall (settings, whole.size()).process (whole);

    const std::string what = "hall mod=" + std::to_string (modulation);
    return check (what.c_str(), whole, [&] (long blockSize) {
        Buffer out (extended.size());
        field::dsp::Hall processor (settings, extended.size());
        for (size_t at = 0; at < extended[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, extended[0].size() - at);
            Buffer block = slice (extended, at, count);
            processor.process (block);
            for (size_t c = 0; c < out.size(); ++c)
                out[c].insert (out[c].end(), block[c].begin(), block[c].end());
        }
        return out;
    });
}

bool checkLimiter (const Buffer& input)
{
    field::dsp::LimiterSettings settings;
    settings.ceilingDb = -1.0;
    settings.lookaheadMs = 5.0;
    settings.releaseMs = 80.0;
    settings.sampleRate = 48000.0;

    // Plus a peak near the top of float's range, so the window's
    // full-depth sizing is exercised rather than assumed.
    Buffer signal = input;
    for (auto& channel : signal)
        channel[channel.size() / 4] = 1e20f;

    Buffer whole = signal;
    field::dsp::limit (whole, settings);

    return check ("limit", whole, [&] (long blockSize) {
        Buffer out (signal.size());
        field::dsp::Limiter processor (settings, signal.size());
        for (size_t at = 0; at < signal[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, signal[0].size() - at);
            processor.process (slice (signal, at, count), out);
        }
        processor.flush (out);
        return out;
    });
}

bool checkResampler (const Buffer& signal, double inRate, double outRate)
{
    const Buffer whole = field::dsp::resample (signal, inRate, outRate);
    const std::string what = "resample " + std::to_string ((long) inRate) + "->"
                             + std::to_string ((long) outRate);

    return check (what.c_str(), whole, [&] (long blockSize) {
        Buffer out (signal.size());
        field::dsp::Resampler processor (inRate, outRate, signal.size());
        for (size_t at = 0; at < signal[0].size(); at += (size_t) blockSize)
        {
            const size_t count = std::min ((size_t) blockSize, signal[0].size() - at);
            processor.process (slice (signal, at, count), out);
        }
        processor.flush (out);
        return out;
    });
}
} // namespace

int main()
{
    // Default floating-point environment, matching both render paths
    // (realtime.md decision 6, resolved: no flush-to-zero anywhere).
    const Buffer signal = testSignal (48000);

    bool ok = checkEq (signal);
    ok = ok && checkReverb (signal);
    ok = ok && checkPlate (signal, 0.0);
    ok = ok && checkPlate (signal, 0.3);
    ok = ok && checkHall (signal, 0.0);
    ok = ok && checkHall (signal, 0.3);
    ok = ok && checkLimiter (signal);
    ok = ok && checkResampler (signal, 44100.0, 48000.0);
    ok = ok && checkResampler (signal, 48000.0, 44100.0);
    ok = ok && checkResampler (signal, 96000.0, 44100.0);

    if (! ok)
        return 1;
    std::printf ("dsp-check: all block partitions bit-identical\n");
    return 0;
}
