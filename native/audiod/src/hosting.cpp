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
            // Discreteness and the label set, so check can enforce
            // decision 3's split: strings only where the plugin offers
            // labels, and only labels it offers. Bounded — an int
            // parameter with hundreds of steps records its count, not a
            // label list nobody would type.
            param->setProperty ("discrete", hosted->isDiscrete());
            param->setProperty ("steps", hosted->getNumSteps());
            if (hosted->isDiscrete() && hosted->getNumSteps() >= 2 && hosted->getNumSteps() <= 32)
            {
                // Built by hand: getAllValueStrings() comes back empty
                // through the VST3 wrapper (measured), but getText per
                // step is the same information.
                juce::Array<juce::var> labels;
                const auto steps = hosted->getNumSteps();
                for (int step = 0; step < steps; ++step)
                    labels.add (hosted->getText (float (step) / float (steps - 1), 512));
                param->setProperty ("labels", labels);
            }
            params.add (juce::var (param));
        }
        object->setProperty ("params", params);
        return juce::var (object);
    }

    // FIELD_PLUGIN_PATH as a search path, split the way the platform
    // splits PATH. Windows paths carry a drive colon, so splitting on ':'
    // there turns D:\a\VST3 into "D" and a drive-relative \a\VST3 that
    // resolves against whichever drive the process's cwd is on: the scan
    // found the fixture from the checkout's drive while --render-live,
    // running in a temp project on C:, did not.
    juce::FileSearchPath pluginPathFromEnvironment (const juce::String& extra)
    {
#if defined(_WIN32)
        const char* separator = ";";
#else
        const char* separator = ":";
#endif
        juce::FileSearchPath searchPath;
        for (const auto& piece : juce::StringArray::fromTokens (extra, separator, ""))
            searchPath.addIfNotAlreadyThere (juce::File (piece));
        return searchPath;
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
        searchPath = pluginPathFromEnvironment (extra);
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

juce::Optional<juce::AudioPlayHead::PositionInfo> TrackPlayHead::getPosition() const
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

namespace
{
    // Decision 11's instantiation-time verify, shared by the offline arm
    // and the live stage: checked after state and params are applied and
    // prepareToPlay has run, because that is when the report is real.
    void verifyDeclaredLatency (juce::AudioPluginInstance& instance,
                                const juce::String& displayName,
                                long long declaredLatency)
    {
        const auto reported = (long long) instance.getLatencySamples();
        if (reported != declaredLatency)
            throw std::runtime_error (displayName.toStdString() + " reports "
                                      + std::to_string (reported)
                                      + " samples of latency but the insert declares "
                                      + std::to_string (declaredLatency) + " — set latency: "
                                      + std::to_string (reported)
                                      + " on the insert (field plugins pin writes the default; a "
                                        "parameter that changes latency changes the line too)");
    }

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
                searchPath = pluginPathFromEnvironment (extra);
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
            // An id whose display name disagrees is the typo an
            // inventory-backed check would have caught — a machine
            // rendering without one must not quietly move a different
            // knob (Codex).
            if (wantId.isNotEmpty() && target->getName (512) != wantName)
                throw std::runtime_error ("param \"" + name.toStdString() + "\": id "
                                          + wantId.toStdString() + " is named \""
                                          + target->getName (512).toStdString() + "\", not \""
                                          + wantName.toStdString() + "\"");

            // Decision 3's split holds here too, scan or no scan: a
            // string spelling is only for labeled parameters. A display
            // string on a continuous parameter is the laundering the
            // decision forbids.
            if (value.isString() && ! target->isDiscrete())
                throw std::runtime_error (displayName.toStdString() + " param \""
                                          + wantName.toStdString()
                                          + "\" takes a number — string spellings are for "
                                            "labeled parameters");

            const auto text = value.isString() ? value.toString()
                                               : juce::String (double (value), 12);
            const auto normalized = target->getValueForText (text);
            // Outside [0,1] is the plugin saying it did not recognize
            // the spelling — refuse rather than render a default under
            // a key claiming the authored value. The VST3 layer clamps
            // this signal away (measured), so discrete parameters get a
            // second guard below.
            if (normalized < 0.0f || normalized > 1.0f)
                throw std::runtime_error (displayName.toStdString()
                                          + " does not recognize \"" + text.toStdString()
                                          + "\" for parameter \"" + wantName.toStdString()
                                          + "\" — spell the value as the plugin displays it");
            target->setValue (normalized);

            // Discrete parameters can verify by display round-trip: the
            // landed value's own text must match what was authored, or
            // an unrecognized spelling has silently become the default
            // (Codex — labeled parameters take their label as a string:
            // `Ratio: "4:1"`). Two-state parameters are exempt, since
            // "On" legitimately spells 1, and continuous ones are not
            // judged: their display rounds and rescales ("1.0 kHz").
            if (target->isDiscrete() && target->getNumSteps() > 2)
            {
                const auto shown = target->getText (target->getValue(), 512).trim();
                const bool displayMatches =
                    value.isString() ? shown.equalsIgnoreCase (text.trim())
                                     : std::abs (shown.getDoubleValue() - double (value)) <= 0.5;
                if (! displayMatches)
                    throw std::runtime_error (displayName.toStdString() + " reads \""
                                              + text.toStdString() + "\" for parameter \""
                                              + wantName.toStdString() + "\" as \""
                                              + shown.toStdString()
                                              + "\" — spell the value as the plugin displays it");
            }
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

    // A stale pin or a latency-changing parameter must refuse rather
    // than render with PDC quietly wrong (decision 11).
    const auto declaredLatency = std::llround (requireInsertNumber (insert, "latency"));
    verifyDeclaredLatency (*instance, displayName, declaredLatency);

    const size_t inputLength = channels[0].size();
    const auto latencySamples = size_t (declaredLatency);

    // Declared tail renders exactly that long; no declaration rings out
    // to −60 dBFS with a hard cap (decision 11). Both are deterministic:
    // the plugin is fed the same blocks either way, and detection is
    // exact-sample truncation of deterministic output.
    const auto tailVar = insert.getProperty ("tail", juce::var());
    const bool declaredTail = tailVar.isDouble() || tailVar.isInt() || tailVar.isInt64();
    constexpr double ringoutCapSeconds = 30.0;
    constexpr float ringoutThreshold = 1.0e-3f; // −60 dBFS

    // Rendered length is measured *after* the latency trim, so the run
    // pads by the declared latency up front: a 480-sample tail with 128
    // samples of latency renders 480 + 128 and trims back to exactly
    // 480 — the pre-fix code delivered 352 (Codex). The delayed input
    // itself ends at inputLength + latency, which is where the ring-out
    // window starts.
    const size_t tailSamples =
        declaredTail ? size_t (std::llround (double (tailVar) * sampleRate))
                     : size_t (std::llround (ringoutCapSeconds * sampleRate));
    const size_t inputEnd = inputLength + latencySamples;

    std::vector<std::vector<float>> output (static_cast<size_t> (numChannels));
    for (auto& channel : output)
        channel.reserve (inputLength + tailSamples);

    juce::AudioBuffer<float> block (numChannels, blockSize);
    juce::MidiBuffer midi;
    size_t consumed = 0;
    size_t emitted = 0;
    size_t lastLoud = 0;
    bool sawLoud = false;

    const size_t totalToRender = inputEnd + tailSamples;
    while (emitted < totalToRender)
    {
        const auto blockStart = consumed;

        // Blocks split at tempo-segment boundaries, so the position info
        // a block carries is a pure function of sample position rather
        // than of how the run happened to be partitioned. Hosts report
        // the playhead once per block and plugins extrapolate within it
        // — splitting is what keeps that extrapolation from crossing a
        // boundary, and what lets the live path (device-sized blocks,
        // chunk 2) supply byte-identical context (decision 13).
        int blockLen = blockSize;
        for (const auto& segment : playHead.segments)
        {
            if (size_t (segment.sample) > blockStart
                && size_t (segment.sample) < blockStart + size_t (blockLen))
                blockLen = int (size_t (segment.sample) - blockStart);
        }

        block.clear();
        for (int channel = 0; channel < numChannels; ++channel)
        {
            auto* data = block.getWritePointer (channel);
            const auto& source = channels[size_t (channel)];
            for (int i = 0; i < blockLen; ++i)
            {
                const auto index = blockStart + size_t (i);
                data[i] = index < inputLength ? source[index] : 0.0f;
            }
        }
        consumed += size_t (blockLen);

        playHead.positionSamples = juce::int64 (blockStart);
        juce::AudioBuffer<float> view (block.getArrayOfWritePointers(), numChannels, blockLen);
        instance->processBlock (view, midi);

        const auto take = juce::jmin (size_t (blockLen), totalToRender - emitted);
        for (int channel = 0; channel < numChannels; ++channel)
        {
            const auto* data = block.getReadPointer (channel);
            auto& sink = output[size_t (channel)];
            for (size_t i = 0; i < take; ++i)
            {
                const auto sample = data[i];
                sink.push_back (sample);
                if (! declaredTail && emitted + i >= inputEnd
                    && std::abs (sample) >= ringoutThreshold)
                {
                    // max, not assignment: channels walk sequentially,
                    // and a quieter-later right channel must not pull
                    // the mark back before the left one's tail (Codex).
                    lastLoud = juce::jmax (lastLoud, emitted + i);
                    sawLoud = true;
                }
            }
        }
        emitted += take;

        // Ring-out ends when a whole second past the input has stayed
        // under the threshold — a plateau check rather than first-quiet,
        // so a beat-gated tail is not cut at its first trough.
        if (! declaredTail && emitted > inputEnd)
        {
            const auto quietSince = sawLoud ? lastLoud : inputEnd;
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
        // Both bounds in pre-trim coordinates: never shorter than the
        // delayed input (so a silent stem keeps its full length after
        // the trim), never longer than the last loud sample.
        const auto keep = sawLoud ? juce::jmax (lastLoud + 1, inputEnd) : inputEnd;
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

namespace
{
    // Plugin instantiation belongs to the message thread: JUCE's
    // synchronous create *posts* there and waits when called from
    // anywhere else, so a caller holding the MessageManagerLock waits
    // forever on its own lock — minjudd hung `field play` with exactly
    // that (#150). The helper marshals the whole job, and refuses the
    // deadlock case loudly instead of reproducing it.
    void runOnMessageThread (const std::function<void()>& job)
    {
        auto* messageManager = juce::MessageManager::getInstance();
        if (messageManager->isThisTheMessageThread())
        {
            job();
            return;
        }
        if (messageManager->currentThreadHasLockedMessageManager())
            throw std::runtime_error (
                "plugin instantiation needs a free message thread, but this thread holds the "
                "MessageManagerLock — hosted session loads must run outside it");
        juce::WaitableEvent done;
        std::string error;
        juce::MessageManager::callAsync (
            [&job, &error, &done]
            {
                try
                {
                    job();
                }
                catch (const std::exception& e)
                {
                    error = e.what();
                }
                catch (...)
                {
                    error = "plugin instantiation failed";
                }
                done.signal();
            });
        done.wait();
        if (! error.empty())
            throw std::runtime_error (error);
    }
} // namespace

LivePluginStage::LivePluginStage (const Spec& stageSpec, double sampleRate, int maxBlockArg)
    : spec (stageSpec), rate (sampleRate), maxBlock (maxBlockArg)
{
    ensureJuceRuntime();
    runOnMessageThread (
        [this, sampleRate]
        {
            instance = instantiateByIdentity (juce::String (spec.format),
                                              juce::String (spec.identifier),
                                              juce::String (spec.name),
                                              juce::String (spec.version),
                                              juce::String (spec.pathHint), sampleRate);

            // Restore order is blob, then params (decision 5) — the
            // offline arm's order exactly.
            if (! spec.statePath.empty())
            {
                juce::MemoryBlock blob;
                if (! juce::File (juce::String (spec.statePath)).loadFileAsData (blob))
                    throw std::runtime_error ("could not read state blob " + spec.statePath);
                instance->setStateInformation (blob.getData(), int (blob.getSize()));
            }
            applyParamEntries (*instance, spec.params.getArray(), juce::String (spec.name));

            const auto layout = juce::AudioChannelSet::stereo();
            if (! instance->setBusesLayout (
                    juce::AudioProcessor::BusesLayout { { layout }, { layout } }))
                throw std::runtime_error (spec.name + " does not support stereo processing");

            playHead.sampleRate = rate;
            playHead.segments = spec.segments;
            instance->setPlayHead (&playHead);
            instance->setNonRealtime (false);
            try
            {
                instance->prepareToPlay (rate, maxBlock);
                verifyDeclaredLatency (*instance, juce::String (spec.name), spec.latency);
            }
            catch (...)
            {
                // The destructor will not run for a half-constructed
                // object, so the refusal path tears down by hand — a
                // clean load error must stay a clean load error.
                instance->releaseResources();
                instance->setPlayHead (nullptr);
                instance.reset();
                throw;
            }
        });

    buffer.setSize (2, maxBlock);
    emitScratch.assign (2, {});
    for (auto& channel : emitScratch)
        channel.reserve ((size_t) maxBlock + (size_t) spec.latency);
    toPrime = spec.latency;
}

LivePluginStage::~LivePluginStage()
{
    if (instance != nullptr)
    {
        instance->releaseResources();
        instance->setPlayHead (nullptr);
    }
}

void LivePluginStage::startAt (juce::int64 clockSample)
{
    clockPos = clockSample;
    toPrime = spec.latency;
}

void LivePluginStage::reset()
{
    // The processor's own state-clear (delay lines, tails, voices);
    // configuration — blob and params — was applied at construction
    // and playback never moves it (chunk 3's editor is a different
    // signal). A plugin that ignores reset() still meets the far-seek
    // contract through the warmup render: chainWarmup grants a hosted
    // stage its tail, its latency window, and a one-second floor, so
    // pre-seek memory decays below the −60 dB bound before anything
    // is heard — the only claim the design makes for hosted state.
    instance->reset();
}

void LivePluginStage::process (std::vector<std::vector<float>>& working)
{
    const auto n = (juce::int64) working[0].size();
    auto& emitted = emitScratch;
    for (auto& channel : emitted)
        channel.clear();

    juce::int64 done = 0;
    while (done < n)
    {
        // Blocks split at tempo-segment boundaries, the offline arm's
        // rule, so the playhead a block carries is a pure function of
        // sample position however the run is partitioned (decision 13).
        auto len = (int) std::min<juce::int64> (maxBlock, n - done);
        for (const auto& segment : playHead.segments)
            if (segment.sample > clockPos && segment.sample < clockPos + len)
                len = (int) (segment.sample - clockPos);

        for (int c = 0; c < 2; ++c)
        {
            auto* data = buffer.getWritePointer (c);
            const auto& source = working[(size_t) c];
            for (int i = 0; i < len; ++i)
                data[i] = source[(size_t) (done + i)];
        }
        playHead.positionSamples = clockPos;
        juce::AudioBuffer<float> view (buffer.getArrayOfWritePointers(), 2, len);
        instance->processBlock (view, midi);

        // The stream lags by the declared latency: the first window of
        // output is the plugin's alignment debt, dropped here and
        // released by flush() — the limiter's contract.
        const auto drop = (int) std::min<juce::int64> (toPrime, len);
        toPrime -= drop;
        for (int c = 0; c < 2; ++c)
        {
            const auto* data = buffer.getReadPointer (c);
            emitted[(size_t) c].insert (emitted[(size_t) c].end(), data + drop, data + len);
        }
        clockPos += len;
        done += len;
    }
    // Copy-assign rather than move: `emitted` is the reused scratch, and
    // `working` (the engine's own scratch) keeps its capacity, so the
    // steady state allocates nothing.
    for (int c = 0; c < 2; ++c)
        working[(size_t) c].assign (emitted[(size_t) c].begin(), emitted[(size_t) c].end());
}

void LivePluginStage::flush (std::vector<std::vector<float>>& tail)
{
    if (spec.latency <= 0)
    {
        for (auto& channel : tail)
            channel.clear();
        return;
    }
    std::vector<std::vector<float>> zeros (2);
    for (auto& channel : zeros)
        channel.assign ((size_t) spec.latency, 0.0f);
    process (zeros);
    tail = std::move (zeros);
}

juce::int64 LivePluginStage::tailSamples() const
{
    return (juce::int64) std::llround (spec.tailSeconds * rate);
}

juce::int64 LivePluginStage::latencySamples() const
{
    return spec.latency;
}
} // namespace field
