#include "plan.h"

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
                   { "frequency", Kind::number, true },
                   { "gain_db", Kind::number, true },
                   { "bandwidth", Kind::number, true } });
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
        if (bands.isEmpty())
            fail (path + ".bands", "must have at least one band");
        for (int i = 0; i < bands.size(); ++i)
            validateBand (bands[i], path + ".bands[" + std::to_string (i) + "]");
    }
    else if (effect == "limit")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "ceiling_db", Kind::number, true },
                       { "lookahead_ms", Kind::number, true, 0.0 },
                       { "release_ms", Kind::number, true, 0.0 } });
    }
    else if (effect == "reverb")
    {
        checkObject (insert,
                     path,
                     { { "effect", Kind::string, true },
                       { "mix", Kind::number, true, 0.0, 1.0 },
                       { "decay", Kind::number, true, 0.0 },
                       { "predelay_ms", Kind::number, true, 0.0 },
                       { "damping", Kind::number, true, 0.0, 1.0 } });
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
                           { "duration", Kind::integer, true, 0.0 },
                           { "read_offset", Kind::integer, true },
                           { "gain_db", Kind::number, true },
                           { "fade_in", Kind::number, true, 0.0 },
                           { "fade_out", Kind::number, true, 0.0 } });
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
                       { "length_samples", Kind::integer, false, 0.0 },
                       { "loop", Kind::boolean, false } });
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
        if (object->hasProperty ("loop") && (bool) object->getProperty ("loop")
            && ! object->hasProperty ("length_samples"))
            fail (path + ".loop", "needs \"length_samples\" to fold onto");
        validateChain (plan, "master", path, false);
    }
    else
    {
        fail (path + ".op", "unknown render op \"" + op.toStdString() + "\"");
    }
}

} // namespace field
