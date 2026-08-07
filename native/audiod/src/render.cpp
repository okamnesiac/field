#include "render.h"

#include "dsp/biquad.h"
#include "dsp/limiter.h"
#include "dsp/reverb.h"
#include "dsp/wavfile.h"

#include <juce_core/juce_core.h>

#include <stdexcept>

namespace field
{
namespace
{
double numberOr (const juce::var& object, const char* key, double fallback)
{
    const auto value = object.getProperty (key, juce::var());
    return value.isVoid() ? fallback : (double) value;
}

// One insert chain, applied in series. The mirror of applyInsertChain in
// src/audio/insert-chain.ts, and it stays a mirror until chunk 4 deletes
// that file: eq and limit work in place, reverb returns longer buffers
// (its tail), and the order is the order the user declared.
void applyInsert (const juce::var& insert,
                  std::vector<std::vector<float>>& channels,
                  double sampleRate)
{
    const auto effect = insert.getProperty ("effect", juce::var()).toString();

    if (effect == "eq")
    {
        const auto* bandArray = insert.getProperty ("bands", juce::var()).getArray();
        if (bandArray == nullptr)
            throw std::runtime_error ("eq insert has no bands");

        std::vector<dsp::Band> bands;
        for (const auto& entry : *bandArray)
        {
            dsp::Band band;
            band.type = entry.getProperty ("type", juce::var()).toString().toStdString();
            band.frequency = numberOr (entry, "frequency", 1000.0);
            band.gainDb = numberOr (entry, "gain_db", 0.0);
            band.bandwidth = numberOr (entry, "bandwidth", 2.0);
            bands.push_back (band);
        }

        for (const auto& band : bands)
        {
            const auto biquad = dsp::design (band, sampleRate);
            for (auto& channel : channels)
                dsp::processBiquad (channel.data(), (int) channel.size(), biquad);
        }

        if (insert.getProperty ("normalize", juce::var (true)))
        {
            const double gain = std::pow (10.0, dsp::autoGainDb (bands, sampleRate) / 20.0);
            for (auto& channel : channels)
                for (auto& sample : channel)
                    sample = (float) ((double) sample * gain);
        }
    }
    else if (effect == "limit")
    {
        dsp::LimiterSettings settings;
        settings.ceilingDb = numberOr (insert, "ceiling_db", -1.0);
        settings.lookaheadMs = numberOr (insert, "lookahead_ms", 5.0);
        settings.releaseMs = numberOr (insert, "release_ms", 100.0);
        settings.sampleRate = sampleRate;
        dsp::limit (channels, settings);
    }
    else if (effect == "reverb")
    {
        dsp::ReverbSettings settings;
        settings.mix = numberOr (insert, "mix", 0.3);
        settings.decaySeconds = numberOr (insert, "decay", 2.0);
        settings.predelayMs = numberOr (insert, "predelay_ms", 0.0);
        settings.damping = numberOr (insert, "damping", 0.5);
        settings.sampleRate = sampleRate;
        channels = dsp::reverb (channels, settings);
    }
    else
    {
        // Not a silent no-op: an insert the daemon does not know is a
        // version skew between the control plane and the binary, and
        // rendering the chain without it would cache audio that does not
        // match what was declared.
        throw std::runtime_error ("unknown insert effect \"" + effect.toStdString() + "\"");
    }
}
} // namespace

std::string runRender (const std::string& planPath)
{
    try
    {
        const juce::File planFile { juce::String (planPath) };
        if (! planFile.existsAsFile())
            return planPath + ": no such render plan";

        const auto plan = juce::JSON::parse (planFile.loadFileAsString());
        if (! plan.isObject())
            return planPath + ": render plan is not a JSON object";

        const auto input = plan.getProperty ("input", juce::var()).toString().toStdString();
        const auto output = plan.getProperty ("output", juce::var()).toString().toStdString();
        if (input.empty() || output.empty())
            return planPath + ": render plan needs both input and output";

        auto wav = dsp::readWav (input);
        const double sampleRate = wav.sampleRate;
        auto channels = std::move (wav.channels);

        if (const auto* inserts = plan.getProperty ("inserts", juce::var()).getArray())
            for (const auto& insert : *inserts)
                applyInsert (insert, channels, sampleRate);

        dsp::writeWavFloat32 (output, sampleRate, channels);
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
}

} // namespace field
