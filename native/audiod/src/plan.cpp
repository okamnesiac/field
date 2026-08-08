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

void validateSampleRate (const juce::var& plan, const std::string& path)
{
    const double rate = (double) plan.getProperty ("sample_rate", juce::var());
    for (const int supported : limits::sampleRates)
        if (rate == (double) supported)
            return;
    fail (path + ".sample_rate",
          "is not a rate this project supports (" + std::to_string ((long) rate) + ")");
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

    if (op == "effects")
    {
        checkObject (plan,
                     path,
                     { { "version", Kind::integer, true },
                       { "op", Kind::string, true },
                       { "input", Kind::string, true },
                       { "output", Kind::string, true },
                       { "inserts", Kind::array, true } });
        validateChain (plan, "inserts", path, true);
    }
    else if (op == "stem")
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
                       { "inserts", Kind::array, false } });
        validateSampleRate (plan, path);
        validateInputs (plan, path);
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
                           // A zero-length clip contributes nothing while
                           // the key says it does; `samples` is int ≥ 0 in
                           // the schema, so fades are integers too.
                           { "duration", Kind::integer, true, 1.0 },
                           { "read_offset", Kind::integer, true },
                           { "gain_db", Kind::number, true },
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
    else if (op == "mix")
    {
        checkObject (plan,
                     path,
                     { { "version", Kind::integer, true },
                       { "op", Kind::string, true },
                       { "output", Kind::string, true },
                       { "sample_rate", Kind::integer, true, 1.0 },
                       { "inputs", Kind::array, true },
                       { "faders", Kind::array, true },
                       { "gain_db", Kind::number, true },
                       { "master", Kind::array, false },
                       // Zero is a legitimate declared length: it means
                       // an empty bounce, which is what the reference
                       // produced and what this renders. Only *looping*
                       // needs it positive — see the cross-field rule
                       // below, where the stride would otherwise be zero.
                       { "length_samples", Kind::integer, false, 0.0 },
                       { "loop", Kind::boolean, false } });
        validateSampleRate (plan, path);
        validateInputs (plan, path);
        const auto& faders = arrayAt (plan, "faders");
        for (int i = 0; i < faders.size(); ++i)
            checkObject (faders[i],
                         path + ".faders[" + std::to_string (i) + "]",
                         { { "gain_db", Kind::number, true },
                           { "pan", Kind::number, true, -1.0, 1.0 } });
        if ((int) faders.size() != arrayAt (plan, "inputs").size())
            fail (path + ".faders",
                  "has " + std::to_string (faders.size()) + " entries for "
                      + std::to_string (arrayAt (plan, "inputs").size()) + " inputs");
        // Cross-field: looping folds the overhang back onto the declared
        // length, so without one there is nothing to fold onto and the
        // flag would be silently ignored.
        auto* object = plan.getDynamicObject();
        if (object->hasProperty ("loop") && (bool) object->getProperty ("loop"))
        {
            if (! object->hasProperty ("length_samples"))
                fail (path + ".loop", "needs \"length_samples\" to fold onto");
            if ((double) object->getProperty ("length_samples") <= 0.0)
                fail (path + ".loop", "needs a positive \"length_samples\" to fold onto");
        }
        validateChain (plan, "master", path, false);
    }
    else
    {
        fail (path + ".op", "unknown render op \"" + op.toStdString() + "\"");
    }
}

} // namespace field
