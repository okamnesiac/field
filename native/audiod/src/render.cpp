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
// The version this binary speaks. Bumped whenever the plan's meaning
// changes — a new effect, a new band type, a field whose units move.
// `daemonBinary()` deliberately reuses whatever build already exists, so
// a control plane newer than the binary is the normal case rather than an
// exotic one, and this is what makes that a clear error instead of a
// quietly wrong render. Separate from the socket's PROTOCOL_VERSION: they
// version different conversations and can move independently.
constexpr int renderPlanVersion = 1;

// Required, not defaulted. The schema fills every field before it is
// serialized (zod applies the defaults), so an absent one means the two
// sides disagree about the shape — which must not resolve to "render
// something plausible".
double requireNumber (const juce::var& object, const char* key, const char* what)
{
    const auto value = object.getProperty (key, juce::var());
    if (value.isVoid())
        throw std::runtime_error (std::string (what) + " is missing \"" + key + "\"");
    return (double) value;
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
            band.frequency = requireNumber (entry, "frequency", "eq band");
            band.gainDb = requireNumber (entry, "gain_db", "eq band");
            band.bandwidth = requireNumber (entry, "bandwidth", "eq band");
            bands.push_back (band);
        }

        for (const auto& band : bands)
        {
            const auto biquad = dsp::design (band, sampleRate);
            for (auto& channel : channels)
                dsp::processBiquad (channel.data(), (int) channel.size(), biquad);
        }

        const auto normalize = insert.getProperty ("normalize", juce::var());
        if (normalize.isVoid())
            throw std::runtime_error ("eq insert is missing \"normalize\"");
        if ((bool) normalize)
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
        settings.ceilingDb = requireNumber (insert, "ceiling_db", "limit insert");
        settings.lookaheadMs = requireNumber (insert, "lookahead_ms", "limit insert");
        settings.releaseMs = requireNumber (insert, "release_ms", "limit insert");
        settings.sampleRate = sampleRate;
        dsp::limit (channels, settings);
    }
    else if (effect == "reverb")
    {
        dsp::ReverbSettings settings;
        settings.mix = requireNumber (insert, "mix", "reverb insert");
        settings.decaySeconds = requireNumber (insert, "decay", "reverb insert");
        settings.predelayMs = requireNumber (insert, "predelay_ms", "reverb insert");
        settings.damping = requireNumber (insert, "damping", "reverb insert");
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

        const auto version = plan.getProperty ("version", juce::var());
        if (version.isVoid() || (int) version != renderPlanVersion)
            return planPath + ": render plan version " + version.toString().toStdString()
                   + " but this field-audiod speaks " + std::to_string (renderPlanVersion)
                   + " — rebuild the daemon (pnpm build:native)";

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
