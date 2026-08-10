#include "render.h"

#include "dsp/biquad.h"
#include "dsp/limiter.h"
#include "dsp/mixdown.h"
#include "dsp/resample.h"
#include "dsp/reverb.h"
#include "dsp/wavfile.h"
#include "plan.h"

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
constexpr int renderPlanVersion = 7;

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

std::string requireString (const juce::var& object, const char* key, const char* what)
{
    const auto value = object.getProperty (key, juce::var());
    if (value.isVoid())
        throw std::runtime_error (std::string (what) + " is missing \"" + key + "\"");
    return value.toString().toStdString();
}

// A required array must be present and be an array. Empty is fine — an
// empty clip list is a legitimate stem — but absent or the wrong type is
// a shape mismatch, and treating it as empty renders a no-op under an
// action key describing real work.
//
// The line this draws is schema optionality, not convenience: `inserts`
// and `master` are genuinely omitted when they have no entries (so
// insert-less stems keep their pre-inserts action keys), and those stay
// conditional. `clips`, `inputs` and `faders` are always serialized.
const juce::Array<juce::var>& requireArray (const juce::var& object,
                                            const char* key,
                                            const char* what)
{
    const auto* array = object.getProperty (key, juce::var()).getArray();
    if (array == nullptr)
        throw std::runtime_error (std::string (what) + " needs \"" + key
                                  + "\" to be an array");
    return *array;
}

// Read every input named by the plan. The control plane has already
// checked rates and channel counts against the project (that is where the
// user-facing diagnostics live), so anything wrong here is a bug rather
// than a mistake, and it surfaces as one.
std::vector<std::vector<std::vector<float>>> readInputs (const juce::var& plan)
{
    std::vector<std::vector<std::vector<float>>> result;
    for (const auto& entry : requireArray (plan, "inputs", "render plan"))
        result.push_back (dsp::readWav (entry.toString().toStdString()).channels);
    return result;
}

// One insert chain, applied in series: eq and limit work in place, reverb
// returns longer buffers (its tail), and the order is the order the user
// declared.
//
// This is now the only implementation. It began as a mirror of
// applyInsertChain in src/audio/insert-chain.ts, which chunk 4 deleted —
// so do not go looking for a reference version to check this against.
// What pins the behaviour is src/generators/effect-properties.test.ts,
// measured from rendered output, and the byte-identity goldens in
// src/audio/render-daemon.test.ts.
// `required` is the schema's own optionality, per operation: an effects
// plan always serializes `inserts`, while a stem's `inserts` and a mix's
// `master` are omitted when they have no entries — that omission is what
// keeps insert-less stems on their pre-inserts action keys.
enum class ChainPresence
{
    required,
    optional
};

void applyChain (const juce::var& plan,
                 const char* key,
                 const char* what,
                 ChainPresence presence,
                 std::vector<std::vector<float>>& channels,
                 double sampleRate);

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
void applyChain (const juce::var& plan,
                 const char* key,
                 const char* what,
                 ChainPresence presence,
                 std::vector<std::vector<float>>& channels,
                 double sampleRate)
{
    // Optional means *absent* is allowed. Present-but-not-an-array is a
    // shape mismatch either way, and rendering the chain as though it
    // were not there is the same fail-closed violation as dropping a
    // clip: audio cached under a key that still describes the chain.
    if (presence == ChainPresence::optional
        && plan.getProperty (key, juce::var()).isVoid())
        return;

    for (const auto& insert : requireArray (plan, key, what))
        applyInsert (insert, channels, sampleRate);
}

// stem: placed clips summed over their sources, then the track's inserts
// baked in (effects.md §5 — inserts are content, so an insert edit
// re-renders the stem). Clip placement arrived already resolved to
// samples; see mixdown.h on why musical time is not here.
void renderStem (const juce::var& plan, const std::string& output, double sampleRate)
{
    const auto sources = readInputs (plan);

    std::vector<dsp::PlacedClip> clips;
    {
        for (const auto& entry : requireArray (plan, "clips", "stem plan"))
        {
            dsp::PlacedClip clip;
            clip.input = (int) requireNumber (entry, "input", "clip");
            clip.start = (long) requireNumber (entry, "start", "clip");
            clip.duration = (long) requireNumber (entry, "duration", "clip");
            clip.readOffset = (long) requireNumber (entry, "read_offset", "clip");
            clip.gainDb = requireNumber (entry, "gain_db", "clip");
            // Absent means centred. validatePlan has already bounded it if
            // it is here at all, so this reads a value it can trust.
            const auto pan = entry.getProperty ("pan", juce::var());
            clip.pan = pan.isVoid() ? 0.0 : (double) pan;
            clip.fadeIn = requireNumber (entry, "fade_in", "clip");
            clip.fadeOut = requireNumber (entry, "fade_out", "clip");
            clips.push_back (clip);
        }
    }

    auto channels = dsp::sumClips (sources, clips);
    applyChain (plan, "inserts", "stem plan", ChainPresence::optional, channels, sampleRate);

    // After the chain, for the reason renderMix gives: a tail the chain
    // grew still has to respect the bar line. Present only when this track
    // is a song's output.
    const auto declared = plan.getProperty ("length_samples", juce::var());
    if (! declared.isVoid())
        dsp::applyDeclaredLength (channels,
                                  (long) (double) declared,
                                  (bool) plan.getProperty ("loop", juce::var (false)));

    dsp::writeWavFloat32 (output, sampleRate, channels);
}

// mix: stems summed through their faders, then the master gain, then the
// master chain, then the declared length. That order is the decision in
// effects.md §5 — gain drives *into* the limiter, and the length applies
// after the chain so a tail the chain grew still respects the bar line.
void renderMix (const juce::var& plan, const std::string& output, double sampleRate)
{
    const auto stems = readInputs (plan);

    std::vector<dsp::Fader> faders;
    {
        for (const auto& entry : requireArray (plan, "faders", "mix plan"))
        {
            dsp::Fader fader;
            fader.gainDb = requireNumber (entry, "gain_db", "fader");
            fader.pan = requireNumber (entry, "pan", "fader");
            faders.push_back (fader);
        }
    }
    if (faders.size() != stems.size())
        throw std::runtime_error ("mix has " + std::to_string (stems.size()) + " inputs but "
                                  + std::to_string (faders.size()) + " faders");

    auto channels = dsp::sumStems (stems, faders);

    const double masterGain = std::pow (10.0, requireNumber (plan, "gain_db", "mix") / 20.0);
    if (masterGain != 1.0)
        for (auto& channel : channels)
            for (auto& sample : channel)
                sample = (float) ((double) sample * masterGain);

    applyChain (plan, "master", "mix plan", ChainPresence::optional, channels, sampleRate);

    const auto declared = plan.getProperty ("length_samples", juce::var());
    if (! declared.isVoid())
        dsp::applyDeclaredLength (channels,
                                  (long) (double) declared,
                                  (bool) plan.getProperty ("loop", juce::var (false)));

    dsp::writeWavFloat32 (output, sampleRate, channels);
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

        // Shape first, once, before anything reads a value (plan.h). The
        // version check follows it so the message names a version rather
        // than a type error, and `validatePlan` has already established
        // that the field is a genuine integer — `version: 2.9` used to
        // pass this gate by truncation.
        validatePlan (plan);

        const auto version = plan.getProperty ("version", juce::var());
        if ((int) version != renderPlanVersion)
            return planPath + ": render plan version " + version.toString().toStdString()
                   + " but this field-audiod speaks " + std::to_string (renderPlanVersion)
                   + " — rebuild the daemon (pnpm build:native)";

        const auto op = requireString (plan, "op", "render plan");
        const auto output = requireString (plan, "output", "render plan");

        if (op == "effects")
        {
            // One input, its own rate: effects are rate-agnostic DSP and
            // process at the file's rate (single-input.ts says so).
            auto wav = dsp::readWav (requireString (plan, "input", "render plan"));
            auto channels = std::move (wav.channels);
            applyChain (plan,
                        "inserts",
                        "effects plan",
                        ChainPresence::required,
                        channels,
                        wav.sampleRate);
            dsp::writeWavFloat32 (output, wav.sampleRate, channels);
        }
        else if (op == "stem")
        {
            renderStem (plan, output, requireNumber (plan, "sample_rate", "render plan"));
        }
        else if (op == "mix")
        {
            renderMix (plan, output, requireNumber (plan, "sample_rate", "render plan"));
        }
        else if (op == "normalize")
        {
            // normalize: rate and bit depth, and nothing else. The order
            // matters and is the conventional one — resample in full
            // precision, then quantize once, at the end. Quantizing first
            // would put the dither through the resampler's filter, which
            // both colours it and defeats the point of dithering at all.
            auto wav = dsp::readWav (requireString (plan, "input", "render plan"));
            const double rate = requireNumber (plan, "sample_rate", "render plan");
            const int bitDepth = (int) requireNumber (plan, "bit_depth", "render plan");

            auto channels = dsp::resample (wav.channels, wav.sampleRate, rate);
            dsp::ditherTo (channels, bitDepth);
            // Integer PCM at every declared depth, 32 included. `LEI32` is
            // what the outgoing afconvert command asked for and what
            // linux-portability decision 1 says still stands, so writing
            // IEEE float here would have changed the meaning of an
            // existing schema value under a version bump that only claims
            // to change the bytes (#57 review).
            dsp::writeWavInt (output, rate, channels, bitDepth);
        }
        else if (op == "resample")
        {
            // resample: rate and nothing else — the edge conversion the
            // graph mints when a source's rate differs from its consuming
            // track's (multi-rate.md decision 4). Same resampler as
            // normalize (render-pipeline.md §2.9 keeps exactly one), but
            // float32 out and no dither: this op sits between two float
            // stages, and quantizing here would clip a stem legitimately
            // above 0 dBFS before its edge gain is applied. normalize
            // stays what it is — quantization is a delivery choice, made
            // at export.
            auto wav = dsp::readWav (requireString (plan, "input", "render plan"));
            const double rate = requireNumber (plan, "sample_rate", "render plan");
            auto channels = dsp::resample (wav.channels, wav.sampleRate, rate);
            dsp::writeWavFloat32 (output, rate, channels);
        }
        else
        {
            // Same rule as an unknown effect or band type: refuse rather
            // than render something plausible.
            return planPath + ": unknown render op \"" + op + "\"";
        }
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
}

} // namespace field
