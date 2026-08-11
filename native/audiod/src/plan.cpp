#include "plan.h"
#include "plan-limits.h"

#include <cmath>
#include <initializer_list>
#include <stdexcept>
#include <string>

namespace field
{
namespace
{
[[noreturn]] void fail (const std::string& path, const std::string& why)
{
    throw std::runtime_error (path + ": " + why);
}

enum class Kind
{
    number,   // any JSON number
    integer,  // a JSON number with no fractional part
    boolean,
    string,
    array,
    object,
};

struct Field
{
    const char* key;
    Kind kind;
    bool required;
    // Inclusive bounds, applied to numbers only. Left wide open where the
    // schema owns the range; narrowed where a value would be unsafe or
    // silently wrong.
    double min = -1e18;
    double max = 1e18;
};

const char* kindName (Kind kind)
{
    switch (kind)
    {
        case Kind::number: return "a number";
        case Kind::integer: return "an integer";
        case Kind::boolean: return "a boolean";
        case Kind::string: return "a string";
        case Kind::array: return "an array";
        case Kind::object: return "an object";
    }
    return "?";
}

// `juce::var` converts freely — a bool, a numeric string and an object all
// answer a `(double)` cast — so every check here asks what the value *is*
// rather than what it can become. That coercion is what let `ceiling_db:
// {}` become a 0 dB limiter.
bool isNumber (const juce::var& v)
{
    return v.isInt() || v.isInt64() || v.isDouble();
}

void checkField (const juce::var& value, const std::string& path, const Field& field)
{
    switch (field.kind)
    {
        case Kind::number:
        case Kind::integer:
            if (! isNumber (value))
                fail (path, std::string ("expected ") + kindName (field.kind));
            if (field.kind == Kind::integer)
            {
                const double d = (double) value;
                if (std::floor (d) != d)
                    fail (path, "expected an integer");
            }
            {
                const double d = (double) value;
                if (d < field.min || d > field.max)
                    fail (path,
                          "out of range (" + std::to_string (d) + " not within "
                              + std::to_string (field.min) + "…" + std::to_string (field.max) + ")");
            }
            break;
        case Kind::boolean:
            if (! value.isBool())
                fail (path, "expected a boolean");
            break;
        case Kind::string:
            if (! value.isString())
                fail (path, "expected a string");
            break;
        case Kind::array:
            if (! value.isArray())
                fail (path, "expected an array");
            break;
        case Kind::object:
            if (value.getDynamicObject() == nullptr)
                fail (path, "expected an object");
            break;
    }
}

// Required fields present and well typed; optional ones checked when
// present; and — the structural half — no key this binary does not know.
// That last rule is what stops an additive control-plane field from
// describing work the daemon will silently not do.
void checkObject (const juce::var& value,
                  const std::string& path,
                  std::initializer_list<Field> fields)
{
    auto* object = value.getDynamicObject();
    if (object == nullptr)
        fail (path, "expected an object");

    for (const auto& field : fields)
    {
        const auto present = object->hasProperty (field.key);
        if (! present)
        {
            if (field.required)
                fail (path + "." + field.key, "is required");
            continue;
        }
        checkField (object->getProperty (field.key), path + "." + field.key, field);
    }

    for (const auto& property : object->getProperties())
    {
        const auto name = property.name.toString().toStdString();
        bool known = false;
        for (const auto& field : fields)
            if (name == field.key)
                known = true;
        if (! known)
            fail (path + "." + name, "is not a field this field-audiod knows");
    }
}

const juce::Array<juce::var>& arrayAt (const juce::var& object, const char* key)
{
    return *object.getProperty (key, juce::var()).getArray();
}

void validateBand (const juce::var& band, const std::string& path)
{
    checkObject (band,
                 path,
                 { { "type", Kind::string, true },
                   { "frequency", Kind::number, true, limits::eqFrequencyMin, limits::eqFrequencyMax },
                   { "gain_db", Kind::number, true, limits::eqGainDbMin, limits::eqGainDbMax },
                   { "bandwidth", Kind::number, true, limits::eqBandwidthMin, limits::eqBandwidthMax } });
    // The type is checked here as well as in design(), so an unknown band
    // is refused before any allocation rather than partway through one.
    const auto type = band.getProperty ("type", juce::var()).toString();
    if (type != "highpass" && type != "lowshelf" && type != "bell" && type != "highshelf"
        && type != "lowpass")
        fail (path + ".type", "unknown band type \"" + type.toStdString() + "\"");
}

// Cross-field: looping folds the overhang back onto the declared length,
// so without one there is nothing to fold onto and the flag would be
// silently ignored.
void validateDeclaredLength (const juce::var& plan, const std::string& path)
{
    auto* object = plan.getDynamicObject();
    if (! object->hasProperty ("loop") || ! (bool) object->getProperty ("loop"))
        return;
    if (! object->hasProperty ("length_samples"))
        fail (path + ".loop", "needs \"length_samples\" to fold onto");
    if ((double) object->getProperty ("length_samples") <= 0.0)
        fail (path + ".loop", "needs a positive \"length_samples\" to fold onto");
}

void validateInsert (const juce::var& insert, const std::string& path)
{
    if (insert.getDynamicObject() == nullptr)
        fail (path, "expected an object");
    const auto effect = insert.getProperty ("effect", juce::var()).toString();

    if (effect == "eq")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "bands", Kind::array, true },
                       { "normalize", Kind::boolean, true } });
        const auto& bands = arrayAt (insert, "bands");
        // An eq with no bands is a byte-identical no-op, which is a chain
        // that does nothing under a key that says it does something.
        if (bands.size() < limits::eqBandsMin || bands.size() > limits::eqBandsMax)
            fail (path + ".bands",
                  "must hold " + std::to_string (limits::eqBandsMin) + "–"
                      + std::to_string (limits::eqBandsMax) + " bands, not "
                      + std::to_string (bands.size()));
        for (int i = 0; i < bands.size(); ++i)
            validateBand (bands[i], path + ".bands[" + std::to_string (i) + "]");
    }
    else if (effect == "limit")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "ceiling_db", Kind::number, true, limits::limitCeilingDbMin, limits::limitCeilingDbMax },
                       { "lookahead_ms", Kind::number, true, limits::limitLookaheadMsMin, limits::limitLookaheadMsMax },
                       { "release_ms", Kind::number, true, limits::limitReleaseMsMin, limits::limitReleaseMsMax } });
    }
    else if (effect == "reverb")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "mix", Kind::number, true, limits::reverbMixMin, limits::reverbMixMax },
                       { "decay", Kind::number, true, limits::reverbDecayMin, limits::reverbDecayMax },
                       { "predelay_ms", Kind::number, true, limits::reverbPredelayMsMin, limits::reverbPredelayMsMax },
                       { "damping", Kind::number, true, limits::reverbDampingMin, limits::reverbDampingMax } });
    }
    else if (effect == "plate")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "mix", Kind::number, true, limits::plateMixMin, limits::plateMixMax },
                       { "decay", Kind::number, true, limits::plateDecayMin, limits::plateDecayMax },
                       { "predelay_ms", Kind::number, true, limits::platePredelayMsMin, limits::platePredelayMsMax },
                       { "damping", Kind::number, true, limits::plateDampingMin, limits::plateDampingMax },
                       { "diffusion", Kind::number, true, limits::plateDiffusionMin, limits::plateDiffusionMax },
                       { "modulation", Kind::number, true, limits::plateModulationMin, limits::plateModulationMax } });
    }
    else if (effect == "hall")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "mix", Kind::number, true, limits::hallMixMin, limits::hallMixMax },
                       { "decay", Kind::number, true, limits::hallDecayMin, limits::hallDecayMax },
                       { "decay_low", Kind::number, true, limits::hallDecayLowMin, limits::hallDecayLowMax },
                       { "decay_high", Kind::number, true, limits::hallDecayHighMin, limits::hallDecayHighMax },
                       { "size", Kind::number, true, limits::hallSizeMin, limits::hallSizeMax },
                       { "predelay_ms", Kind::number, true, limits::hallPredelayMsMin, limits::hallPredelayMsMax },
                       { "diffusion", Kind::number, true, limits::hallDiffusionMin, limits::hallDiffusionMax },
                       { "modulation", Kind::number, true, limits::hallModulationMin, limits::hallModulationMax },
                       { "width", Kind::number, true, limits::hallWidthMin, limits::hallWidthMax } });
    }
    else if (effect == "plugin")
    {
        // Hosted plugin (plugin-hosting.md chunk 1). Ranges are the
        // plugin's own business; what the plan owes is shape — and the
        // split between repository facts (identifier, version, hashes)
        // and machine-local facts (paths), which arrive as separate
        // keys precisely so the action key upstream never saw the
        // latter.
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "format", Kind::string, true },
                       { "identifier", Kind::string, true },
                       { "name", Kind::string, true },
                       { "version", Kind::string, true },
                       { "latency", Kind::number, true },
                       { "tail", Kind::number, false },
                       { "state_sha256", Kind::string, false },
                       { "state_path", Kind::string, false },
                       { "path", Kind::string, false },
                       { "params", Kind::array, true },
                       { "transport", Kind::object, true } });
        const auto formatName = insert.getProperty ("format", juce::var()).toString();
        if (formatName != "au" && formatName != "vst3")
            fail (path + ".format", "must be \"au\" or \"vst3\"");
        const auto& params = arrayAt (insert, "params");
        for (int i = 0; i < params.size(); ++i)
        {
            const auto paramPath = path + ".params[" + std::to_string (i) + "]";
            const auto& entry = params[i];
            if (entry.getDynamicObject() == nullptr)
                fail (paramPath, "expected an object");
            if (! entry.getProperty ("name", juce::var()).isString())
                fail (paramPath + ".name", "is required and must be a string");
            // A value is a number in the plugin's natural units, or a
            // string for labeled parameters ("4:1") — the plugin's own
            // display spelling.
            const auto value = entry.getProperty ("value", juce::var());
            if (! (value.isDouble() || value.isInt() || value.isInt64() || value.isString()))
                fail (paramPath + ".value", "must be a number or a string");
        }
        const auto segments =
            insert.getProperty ("transport", juce::var()).getProperty ("segments", juce::var());
        if (segments.getArray() == nullptr || segments.getArray()->isEmpty())
            fail (path + ".transport.segments",
                  "must hold at least one tempo segment (plugin-hosting.md decision 13)");
    }
    else
    {
        fail (path + ".effect", "unknown insert effect \"" + effect.toStdString() + "\"");
    }
}

void validateChain (const juce::var& plan,
                    const char* key,
                    const std::string& path,
                    bool required)
{
    auto* object = plan.getDynamicObject();
    if (! object->hasProperty (key))
    {
        if (required)
            fail (path + "." + key, "is required");
        return;
    }
    const auto value = object->getProperty (key);
    if (! value.isArray())
        fail (path + "." + key, "expected an array");
    const auto& inserts = *value.getArray();
    for (int i = 0; i < inserts.size(); ++i)
        validateInsert (inserts[i], path + "." + key + "[" + std::to_string (i) + "]");
}

void validateBitDepth (const juce::var& plan, const std::string& path)
{
    // checkObject has already proved this is an integer, so compare as
    // one: set membership is an exact question, and asking it in doubles
    // is what -Wfloat-equal is warning about.
    const long depth = (long) (double) plan.getProperty ("bit_depth", juce::var());
    for (const int supported : limits::bitDepths)
        if (depth == (long) supported)
            return;
    fail (path + ".bit_depth",
          "is not a depth normalize can write (" + std::to_string (depth) + ")");
}

void validateSampleRate (const juce::var& plan, const std::string& path)
{
    const long rate = (long) (double) plan.getProperty ("sample_rate", juce::var());
    for (const int supported : limits::sampleRates)
        if (rate == (long) supported)
            return;
    fail (path + ".sample_rate",
          "is not a rate this project supports (" + std::to_string (rate) + ")");
}

void validateInputs (const juce::var& plan, const std::string& path)
{
    const auto& inputs = arrayAt (plan, "inputs");
    for (int i = 0; i < inputs.size(); ++i)
        if (! inputs[i].isString())
            fail (path + ".inputs[" + std::to_string (i) + "]", "expected a string");
}
} // namespace

void validatePlan (const juce::var& plan)
{
    const std::string path = "plan";
    if (plan.getDynamicObject() == nullptr)
        fail (path, "expected an object");
    const auto op = plan.getProperty ("op", juce::var()).toString();

    if (op == "stem")
    {
        checkObject (plan,
                     path,
                     { { "version", Kind::integer, true },
                       { "op", Kind::string, true },
                       { "output", Kind::string, true },
                       // A zero or negative rate writes a WAV nothing can
                       // play back correctly.
                       { "sample_rate", Kind::integer, true, 1.0 },
                       { "inputs", Kind::array, true },
                       { "clips", Kind::array, true },
                       { "inserts", Kind::array, false },
                       // A track can be a song's output, so it carries the
                       // song's declared extent.
                       { "length_samples", Kind::integer, false, 0.0 },
                       { "loop", Kind::boolean, false } });
        validateSampleRate (plan, path);
        validateInputs (plan, path);
        validateDeclaredLength (plan, path);
        const auto& clips = arrayAt (plan, "clips");
        const auto inputCount = (double) arrayAt (plan, "inputs").size();
        for (int i = 0; i < clips.size(); ++i)
        {
            const auto clipPath = path + ".clips[" + std::to_string (i) + "]";
            checkObject (clips[i],
                         clipPath,
                         // start and duration index the output buffer, so
                         // negatives there are memory-unsafe rather than
                         // merely wrong — a negative start indexed before
                         // the allocation (#54 review, confirmed with
                         // AddressSanitizer). read_offset stays unbounded
                         // on purpose: reads outside a source are declared
                         // silence, which is what slip is.
                         { { "input", Kind::integer, true, 0.0, inputCount - 1.0 },
                           { "start", Kind::integer, true, 0.0 },
                           // Zero is legal here and only here: a placement
                           // of an empty track is a window of nothing, and
                           // its length is resolved from the rendered
                           // child rather than authored. An authored
                           // zero-length clip is still refused upstream —
                           // `timeSpan` is positive in the schema — so
                           // this admits the resolved case without
                           // admitting the meaningless one.
                           { "duration", Kind::integer, true, 0.0 },
                           { "read_offset", Kind::integer, true },
                           { "gain_db", Kind::number, true },
                           // Optional because the control plane omits it
                           // when centred; a plan that names it must still
                           // name a real balance.
                           { "pan", Kind::number, false, -1.0, 1.0 },
                           { "fade_in", Kind::integer, true, 0.0 },
                           { "fade_out", Kind::integer, true, 0.0 } });
            // The same fit the control plane checks on the way in
            // (model/project.ts): fades that overlap would each be
            // scaling the other's samples.
            const auto fadeIn = (double) clips[i].getProperty ("fade_in", juce::var());
            const auto fadeOut = (double) clips[i].getProperty ("fade_out", juce::var());
            const auto duration = (double) clips[i].getProperty ("duration", juce::var());
            if (fadeIn + fadeOut > duration)
                fail (clipPath, "fades total " + std::to_string ((long) (fadeIn + fadeOut))
                                    + " samples but the clip is only "
                                    + std::to_string ((long) duration));
        }
        validateChain (plan, "inserts", path, false);
    }
    else if (op == "normalize")
    {
        // Rate and depth and nothing else. No chain: normalize converts,
        // it does not process, so an `inserts` key here would be a plan
        // describing work this op will not do — refused by checkObject
        // along with every other unknown key.
        checkObject (plan,
                     path,
                     { { "version", Kind::integer, true },
                       { "op", Kind::string, true },
                       { "input", Kind::string, true },
                       { "output", Kind::string, true },
                       { "sample_rate", Kind::integer, true, 1.0 },
                       { "bit_depth", Kind::integer, true, 1.0 } });
        validateSampleRate (plan, path);
        validateBitDepth (plan, path);
    }
    else if (op == "resample")
    {
        // Rate and nothing else: the float edge conversion (render.cpp
        // says why it neither dithers nor takes a depth). Same no-chain
        // rule as normalize, enforced the same way — by checkObject
        // refusing unknown keys.
        checkObject (plan,
                     path,
                     { { "version", Kind::integer, true },
                       { "op", Kind::string, true },
                       { "input", Kind::string, true },
                       { "output", Kind::string, true },
                       { "sample_rate", Kind::integer, true, 1.0 } });
        validateSampleRate (plan, path);
    }
    else
    {
        fail (path + ".op", "unknown render op \"" + op.toStdString() + "\"");
    }
}

} // namespace field
