#include "hosting.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace field
{
namespace
{
    bool hostingUsed = false;

    // Instantiation and message-based plugin APIs want a message thread.
    // The render and probe subprocesses have no dispatch loop, so the
    // first hosting call makes the calling thread the message thread
    // for the life of the process. Deliberately leaked (allocated, never
    // freed): its destructor is the static-teardown crash exitSubprocess
    // exists to skip, and a subprocess's teardown has no other duty.
    void ensureJuceRuntime()
    {
        static auto* runtime = new juce::ScopedJuceInitialiser_GUI();
        juce::ignoreUnused (runtime);
        hostingUsed = true;
    }

    std::unique_ptr<juce::AudioPluginFormat> makeFormat (const juce::String& formatName)
    {
        if (formatName == "vst3")
            return std::make_unique<juce::VST3PluginFormat>();
#if JUCE_PLUGINHOST_AU && JUCE_MAC
        if (formatName == "au")
            return std::make_unique<juce::AudioUnitPluginFormat>();
#endif
        throw std::runtime_error ("unknown plugin format \"" + formatName.toStdString() + "\"");
    }

    // The stable identity the YAML pins (plugin-hosting.md decision 2):
    // AU is the type/subtype/manufacturer triple; VST3 is the plugin's
    // unique id in hex. Paths never qualify — they are machine-local.
    juce::String stableIdentifier (const juce::PluginDescription& description)
    {
        if (description.pluginFormatName == "AudioUnit")
        {
            // JUCE spells AU identifiers "AudioUnit:Category/aufx,Sub,Manu";
            // the triple after the last slash is the stable part.
            const auto& file = description.fileOrIdentifier;
            const auto slash = file.lastIndexOfChar ('/');
            const auto triple = slash >= 0 ? file.substring (slash + 1) : file;
            return triple.replaceCharacter (',', '/');
        }
        return juce::String::toHexString (description.uniqueId);
    }

    juce::var describeOne (juce::AudioPluginFormat& format,
                           const juce::PluginDescription& description)
    {
        ensureJuceRuntime();
        juce::AudioPluginFormatManager manager;
        manager.addFormat (makeFormat (format.getName() == "AudioUnit" ? "au" : "vst3").release());

        juce::String error;
        auto instance = manager.createPluginInstance (description, 48000.0, 512, error);
        if (instance == nullptr)
            throw std::runtime_error ("could not instantiate \"" + description.name.toStdString()
                                      + "\": " + error.toStdString());

        auto* object = new juce::DynamicObject();
        object->setProperty ("format", description.pluginFormatName == "AudioUnit" ? "au" : "vst3");
        object->setProperty ("name", description.name);
        object->setProperty ("identifier", stableIdentifier (description));
        object->setProperty ("version", description.version);
        object->setProperty ("manufacturer", description.manufacturerName);
        object->setProperty ("path", description.fileOrIdentifier);
        object->setProperty ("latency", instance->getLatencySamples());

        juce::Array<juce::var> params;
        const auto& parameters = instance->getParameters();
        for (int i = 0; i < parameters.size(); ++i)
        {
            auto* hosted = instance->getHostedParameter (i);
            if (hosted == nullptr)
                continue;
            auto* param = new juce::DynamicObject();
            param->setProperty ("id", hosted->getParameterID());
            param->setProperty ("name", hosted->getName (512));
            param->setProperty ("label", hosted->getLabel());
            params.add (juce::var (param));
        }
        object->setProperty ("params", params);
        return juce::var (object);
    }
} // namespace

bool hostingWasUsed()
{
    return hostingUsed;
}

void exitSubprocess (int code)
{
    std::fflush (stdout);
    std::fflush (stderr);
    std::_Exit (code);
}

int runScanProbe (const std::string& formatName,
                  const std::string& candidate,
                  const std::string& outPath)
{
    ensureJuceRuntime();
    auto format = makeFormat (juce::String (formatName));

    juce::OwnedArray<juce::PluginDescription> found;
    format->findAllTypesForFile (found, juce::String (candidate));
    juce::String lines;
    for (const auto* description : found)
        lines << juce::JSON::toString (describeOne (*format, *description), true) << "\n";

    if (! juce::File (juce::String (outPath)).replaceWithText (lines))
        throw std::runtime_error ("could not write " + outPath);
    return 0;
}

int runScan (const std::string& formatName, const std::string& exePath)
{
    ensureJuceRuntime();
    auto format = makeFormat (juce::String (formatName));

    // FIELD_PLUGIN_PATH, when set, *replaces* the format's default
    // locations — the test suite scans the built fixture hermetically
    // instead of probing every plugin on the machine. Unset means the
    // real folders, which is what users have.
    juce::FileSearchPath searchPath;
    const auto extra = juce::SystemStats::getEnvironmentVariable ("FIELD_PLUGIN_PATH", "");
    if (extra.isNotEmpty())
        for (const auto& piece : juce::StringArray::fromTokens (extra, ":", ""))
            searchPath.addIfNotAlreadyThere (juce::File (piece));
    else
        searchPath = format->getDefaultLocationsToSearch();

    const auto candidates = format->searchPathsForPlugins (searchPath, true, true);

    // One probe subprocess per candidate: a plugin that crashes while
    // being described is a recorded skip, never a dead scan. Results
    // come back through a temp file per candidate — the child's own
    // stdout is plugin territory and is discarded unread.
    for (const auto& candidate : candidates)
    {
        const auto resultFile = juce::File::createTempFile ("field-probe.ndjson");
        juce::ChildProcess probe;
        juce::StringArray args { juce::String (exePath), "--scan-probe",
                                 juce::String (formatName), candidate,
                                 resultFile.getFullPathName() };
        const auto failLine = [&]()
        {
            std::printf ("{\"failed\":%s}\n",
                         juce::JSON::toString (juce::var (candidate), true).toRawUTF8());
        };
        if (! probe.start (args, 0))
        {
            failLine();
            resultFile.deleteFile();
            continue;
        }
        const bool finished = probe.waitForProcessToFinish (30000);
        if (! finished || probe.getExitCode() != 0)
        {
            if (! finished)
                probe.kill();
            failLine();
            resultFile.deleteFile();
            continue;
        }
        std::fputs (resultFile.loadFileAsString().toRawUTF8(), stdout);
        resultFile.deleteFile();
    }
    std::fflush (stdout);
    return 0;
}

namespace
{
    // The track-local playhead (plugin-hosting.md decision 13): position
    // advances on the chain's own sample clock, tempo and meter come
    // from the plan's transport segments, and both render paths supply
    // exactly this. No loop or play/stop state exists — a stem renders
    // as one linear pass.
    class TrackPlayHead final : public juce::AudioPlayHead
    {
    public:
        struct Segment
        {
            juce::int64 sample = 0;
            double ppq = 0.0;
            double bpm = 120.0;
            int numerator = 4;
            int denominator = 4;
        };

        std::vector<Segment> segments;
        juce::int64 positionSamples = 0;
        double sampleRate = 48000.0;

        juce::Optional<PositionInfo> getPosition() const override
        {
            const Segment* active = segments.empty() ? nullptr : &segments.front();
            for (const auto& segment : segments)
                if (segment.sample <= positionSamples)
                    active = &segment;
                else
                    break;

            PositionInfo info;
            info.setTimeInSamples (positionSamples);
            info.setTimeInSeconds (double (positionSamples) / sampleRate);
            info.setIsPlaying (true);
            if (active != nullptr)
            {
                info.setBpm (active->bpm);
                info.setTimeSignature (TimeSignature { active->numerator, active->denominator });
                info.setPpqPosition (active->ppq
                                     + double (positionSamples - active->sample) * active->bpm
                                           / (60.0 * sampleRate));
            }
            return info;
        }
    };

    double requireInsertNumber (const juce::var& insert, const char* name)
    {
        const auto value = insert.getProperty (name, juce::var());
        if (! (value.isDouble() || value.isInt() || value.isInt64()))
            throw std::runtime_error (std::string ("plugin insert is missing \"") + name + "\"");
        return double (value);
    }
} // namespace

namespace
{
    // Find the installed plugin whose stable identity matches, then
    // instantiate it. The optional path hint speeds the lookup; the
    // identity decides, so a stale hint falls back to the full search.
    // An empty pinnedVersion skips the version gate (capture has no
    // pin); a non-empty one refuses drift here — at instantiation,
    // never at cache lookup, which the daemon never does (decision 9).
    std::unique_ptr<juce::AudioPluginInstance>
    instantiateByIdentity (const juce::String& formatName,
                           const juce::String& identifier,
                           const juce::String& displayName,
                           const juce::String& pinnedVersion,
                           const juce::String& hint,
                           double sampleRate)
    {
        auto format = makeFormat (formatName);
        juce::AudioPluginFormatManager manager;
        manager.addFormat (makeFormat (formatName).release());

        juce::OwnedArray<juce::PluginDescription> found;
        if (hint.isNotEmpty())
            format->findAllTypesForFile (found, hint);

        auto findMatch = [&]() -> const juce::PluginDescription*
        {
            for (const auto* description : found)
                if (stableIdentifier (*description) == identifier)
                    return description;
            return nullptr;
        };
        const auto* match = findMatch();
        if (match == nullptr)
        {
            found.clear();
            juce::FileSearchPath searchPath;
            const auto extra = juce::SystemStats::getEnvironmentVariable ("FIELD_PLUGIN_PATH", "");
            if (extra.isNotEmpty())
                for (const auto& piece : juce::StringArray::fromTokens (extra, ":", ""))
                    searchPath.addIfNotAlreadyThere (juce::File (piece));
            else
                searchPath = format->getDefaultLocationsToSearch();
            for (const auto& candidate : format->searchPathsForPlugins (searchPath, true, true))
                format->findAllTypesForFile (found, candidate);
            match = findMatch();
        }
        if (match == nullptr)
            throw std::runtime_error ("this render needs " + displayName.toStdString() + " ("
                                      + formatName.toStdString() + " " + identifier.toStdString()
                                      + " " + pinnedVersion.toStdString()
                                      + "), which is not installed");

        if (pinnedVersion.isNotEmpty() && match->version != pinnedVersion)
            throw std::runtime_error (displayName.toStdString() + " is pinned at "
                                      + pinnedVersion.toStdString()
                                      + " but the installed version is "
                                      + match->version.toStdString()
                                      + " — field plugins pin updates the line deliberately");

        juce::String error;
        auto instance = manager.createPluginInstance (*match, sampleRate, 512, error);
        if (instance == nullptr)
            throw std::runtime_error ("could not instantiate " + displayName.toStdString() + ": "
                                      + error.toStdString());
        return instance;
    }

    // Apply one params array — [{name, value}…] — through the plugin's
    // own conversion. The YAML key is the display name while unique;
    // duplicates are spelled Name#<id> (decision 3), and a bare name
    // matching twice refuses rather than guessing.
    void applyParamEntries (juce::AudioPluginInstance& instance,
                            const juce::Array<juce::var>* paramArray,
                            const juce::String& displayName)
    {
        if (paramArray == nullptr)
            return;
        for (const auto& entry : *paramArray)
        {
            const auto name = entry.getProperty ("name", juce::var()).toString();
            const auto value = entry.getProperty ("value", juce::var());

            juce::String wantName = name;
            juce::String wantId;
            if (const auto hash = name.lastIndexOfChar ('#'); hash >= 0)
            {
                wantName = name.substring (0, hash);
                wantId = name.substring (hash + 1);
            }

            juce::HostedAudioProcessorParameter* target = nullptr;
            int matches = 0;
            const auto& parameters = instance.getParameters();
            for (int i = 0; i < parameters.size(); ++i)
            {
                auto* hosted = instance.getHostedParameter (i);
                if (hosted == nullptr)
                    continue;
                if (wantId.isNotEmpty())
                {
                    if (hosted->getParameterID() == wantId)
                    {
                        target = hosted;
                        matches = 1;
                        break;
                    }
                }
                else if (hosted->getName (512) == wantName)
                {
                    target = hosted;
                    ++matches;
                }
            }
            if (target == nullptr)
                throw std::runtime_error (displayName.toStdString() + " has no parameter \""
                                          + name.toStdString() + "\"");
            if (matches > 1)
                throw std::runtime_error (displayName.toStdString() + " has "
                                          + std::to_string (matches) + " parameters named \""
                                          + wantName.toStdString()
                                          + "\" — spell it Name#<id> to say which");

            const auto text = value.isString() ? value.toString()
                                               : juce::String (double (value), 12);
            target->setValue (target->getValueForText (text));
        }
    }
} // namespace

int runStateCapture (const std::string& formatName,
                     const std::string& identifier,
                     const std::string& paramsJson,
                     const std::string& outPath)
{
    ensureJuceRuntime();
    auto instance = instantiateByIdentity (juce::String (formatName), juce::String (identifier),
                                           juce::String (identifier), juce::String(),
                                           juce::String(), 48000.0);
    const auto params = juce::JSON::parse (juce::String (paramsJson));
    applyParamEntries (*instance, params.getArray(), juce::String (identifier));

    juce::MemoryBlock state;
    instance->getStateInformation (state);
    if (! juce::File (juce::String (outPath)).replaceWithData (state.getData(), state.getSize()))
        throw std::runtime_error ("could not write " + outPath);
    return 0;
}

void applyPluginInsert (const juce::var& insert,
                        std::vector<std::vector<float>>& channels,
                        double sampleRate)
{
    ensureJuceRuntime();

    const auto formatName = insert.getProperty ("format", juce::var()).toString();
    const auto identifier = insert.getProperty ("identifier", juce::var()).toString();
    const auto displayName = insert.getProperty ("name", juce::var()).toString();
    const auto pinnedVersion = insert.getProperty ("version", juce::var()).toString();

    auto instance = instantiateByIdentity (formatName, identifier, displayName, pinnedVersion,
                                           insert.getProperty ("path", juce::var()).toString(),
                                           sampleRate);

    // Restore order is blob, then params (decision 5).
    const auto statePath = insert.getProperty ("state_path", juce::var()).toString();
    if (statePath.isNotEmpty())
    {
        juce::MemoryBlock blob;
        if (! juce::File (statePath).loadFileAsData (blob))
            throw std::runtime_error ("could not read state blob " + statePath.toStdString());
        instance->setStateInformation (blob.getData(), int (blob.getSize()));
    }

    applyParamEntries (*instance, insert.getProperty ("params", juce::var()).getArray(),
                       displayName);

    // Transport, then processing: fixed 512-sample blocks. The block
    // size is part of the recipe — third-party plugins owe us no
    // block-size invariance, so determinism comes from never varying it.
    constexpr int blockSize = 512;

    TrackPlayHead playHead;
    playHead.sampleRate = sampleRate;
    if (const auto* segmentArray =
            insert.getProperty ("transport", juce::var()).getProperty ("segments", juce::var()).getArray())
    {
        for (const auto& entry : *segmentArray)
        {
            TrackPlayHead::Segment segment;
            segment.sample = juce::int64 (requireInsertNumber (entry, "sample"));
            segment.ppq = requireInsertNumber (entry, "ppq");
            segment.bpm = requireInsertNumber (entry, "bpm");
            segment.numerator = int (requireInsertNumber (entry, "numerator"));
            segment.denominator = int (requireInsertNumber (entry, "denominator"));
            playHead.segments.push_back (segment);
        }
    }

    const int numChannels = int (channels.size());
    if (numChannels < 1 || numChannels > 2)
        throw std::runtime_error ("plugin insert expects mono or stereo, got "
                                  + std::to_string (numChannels) + " channels");

    const auto layout = numChannels == 1 ? juce::AudioChannelSet::mono()
                                         : juce::AudioChannelSet::stereo();
    if (! instance->setBusesLayout (juce::AudioProcessor::BusesLayout {
            { layout }, { layout } }))
        throw std::runtime_error (displayName.toStdString() + " does not support "
                                  + std::to_string (numChannels) + "-channel processing");

    instance->setPlayHead (&playHead);
    instance->setNonRealtime (true);
    instance->prepareToPlay (sampleRate, blockSize);

    const size_t inputLength = channels[0].size();
    const auto latencySamples = size_t (std::llround (requireInsertNumber (insert, "latency")));

    // Declared tail renders exactly that long; no declaration rings out
    // to −60 dBFS with a hard cap (decision 11). Both are deterministic:
    // the plugin is fed the same blocks either way, and detection is
    // exact-sample truncation of deterministic output.
    const auto tailVar = insert.getProperty ("tail", juce::var());
    const bool declaredTail = tailVar.isDouble() || tailVar.isInt() || tailVar.isInt64();
    constexpr double ringoutCapSeconds = 30.0;
    constexpr float ringoutThreshold = 1.0e-3f; // −60 dBFS

    const size_t tailSamples =
        declaredTail ? size_t (std::llround (double (tailVar) * sampleRate))
                     : size_t (std::llround (ringoutCapSeconds * sampleRate));

    std::vector<std::vector<float>> output (static_cast<size_t> (numChannels));
    for (auto& channel : output)
        channel.reserve (inputLength + tailSamples);

    juce::AudioBuffer<float> block (numChannels, blockSize);
    juce::MidiBuffer midi;
    size_t consumed = 0;
    size_t emitted = 0;
    size_t lastLoud = 0;
    bool sawLoud = false;

    const size_t totalToRender = inputLength + tailSamples;
    while (emitted < totalToRender)
    {
        block.clear();
        const auto blockStart = consumed;
        for (int channel = 0; channel < numChannels; ++channel)
        {
            auto* data = block.getWritePointer (channel);
            const auto& source = channels[size_t (channel)];
            for (int i = 0; i < blockSize; ++i)
            {
                const auto index = blockStart + size_t (i);
                data[i] = index < inputLength ? source[index] : 0.0f;
            }
        }
        consumed += size_t (blockSize);

        playHead.positionSamples = juce::int64 (blockStart);
        instance->processBlock (block, midi);

        const auto take = juce::jmin (size_t (blockSize), totalToRender - emitted);
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const auto* data = block.getReadPointer (channel);
            auto& sink = output[size_t (channel)];
            for (size_t i = 0; i < take; ++i)
            {
                const auto sample = data[i];
                sink.push_back (sample);
                if (! declaredTail && emitted + i >= inputLength
                    && std::abs (sample) >= ringoutThreshold)
                {
                    lastLoud = emitted + i;
                    sawLoud = true;
                }
            }
        }
        emitted += take;

        // Ring-out ends when a whole second past the input has stayed
        // under the threshold — a plateau check rather than first-quiet,
        // so a beat-gated tail is not cut at its first trough.
        if (! declaredTail && emitted > inputLength)
        {
            const auto quietSince = sawLoud ? lastLoud : inputLength;
            if (emitted > quietSince + size_t (sampleRate))
                break;
        }
    }

    instance->releaseResources();
    instance->setPlayHead (nullptr);

    // Truncate an undeclared tail at its last loud sample, then trim the
    // declared latency from the front — the plugin's alignment debt.
    if (! declaredTail)
    {
        const auto keep = sawLoud ? juce::jmax (lastLoud + 1, inputLength) : inputLength;
        for (auto& channel : output)
            if (channel.size() > keep)
                channel.resize (keep);
    }
    if (latencySamples > 0)
        for (auto& channel : output)
            channel.erase (channel.begin(),
                           channel.begin()
                               + static_cast<std::ptrdiff_t> (
                                   juce::jmin (latencySamples, channel.size())));

    channels = std::move (output);
}
} // namespace field
