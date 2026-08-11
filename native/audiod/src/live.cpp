#include "live.h"

#include "dsp/mixdown.h"
#include "dsp/wavfile.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace field
{
namespace
{
constexpr int liveSessionVersion = 1; // session.ts SESSION_VERSION
constexpr int engineBlock = 512; // internal granularity; output is block-size invariant

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

const juce::Array<juce::var>& requireArray (const juce::var& object,
                                            const char* key,
                                            const char* what)
{
    const auto* array = object.getProperty (key, juce::var()).getArray();
    if (array == nullptr)
        throw std::runtime_error (std::string (what) + " needs \"" + key + "\" to be an array");
    return *array;
}

} // namespace

LiveSession::LiveSession (const juce::var& session, const juce::File& projectRoot)
{
    if ((int) requireNumber (session, "version", "session") != liveSessionVersion)
        throw std::runtime_error ("session version mismatch — rebuild the daemon (pnpm build:native)");
    rate = (int) requireNumber (session, "rate", "session");
    const auto lengthVar = session.getProperty ("length_samples", juce::var());
    length = lengthVar.isVoid() ? 0 : (juce::int64) (double) lengthVar;
    loop = (bool) session.getProperty ("loop", juce::var (false));

    // First pass: indices, so windows can refer forward.
    const auto& trackArray = requireArray (session, "tracks", "session");
    for (const auto& entry : trackArray)
    {
        Track track;
        track.name = requireString (entry, "name", "track");
        track.rate = (int) requireNumber (entry, "rate", "track");
        if (track.rate != rate)
            throw std::runtime_error ("track \"" + track.name
                                      + "\" declares a foreign rate — live cross-rate edges land "
                                        "with the resampler wiring, later in chunk 2");
        trackIndex[track.name] = (int) tracks.size();
        tracks.push_back (std::move (track));
    }

    const auto outputName = requireString (session, "output", "session");
    if (trackIndex.find (outputName) == trackIndex.end())
        throw std::runtime_error ("session output \"" + outputName + "\" is not a track");
    outputTrack = trackIndex[outputName];

    // Second pass: windows, chains, buffers.
    std::map<std::string, int> fileIndex;
    for (int t = 0; t < (int) trackArray.size(); ++t)
    {
        const auto& entry = trackArray.getReference (t);
        Track& track = tracks[(size_t) t];

        for (const auto& input : requireArray (entry, "inputs", "track"))
        {
            Window window;
            window.start = (juce::int64) requireNumber (input, "start", "window");
            window.duration = (juce::int64) requireNumber (input, "duration", "window");
            window.readOffset = (juce::int64) requireNumber (input, "read_offset", "window");
            window.gainDb = requireNumber (input, "gain_db", "window");
            const auto pan = input.getProperty ("pan", juce::var());
            window.pan = pan.isVoid() ? 0.0 : (double) pan;
            window.fadeIn = (juce::int64) requireNumber (input, "fade_in", "window");
            window.fadeOut = (juce::int64) requireNumber (input, "fade_out", "window");
            if (window.start < 0 || window.duration < 0)
                throw std::runtime_error ("window has negative start or duration");

            const auto file = input.getProperty ("file", juce::var());
            const auto child = input.getProperty ("track", juce::var());
            const auto receive = input.getProperty ("receive", juce::var());
            if (! file.isVoid())
            {
                window.kind = Window::file;
                const auto path = file.toString().toStdString();
                if (fileIndex.find (path) == fileIndex.end())
                {
                    fileIndex[path] = (int) files.size();
                    files.push_back (
                        dsp::readWav (projectRoot.getChildFile (juce::String (path))
                                          .getFullPathName()
                                          .toStdString())
                            .channels);
                }
                window.source = fileIndex[path];
            }
            else
            {
                const auto name = (! child.isVoid() ? child : receive).toString().toStdString();
                if (trackIndex.find (name) == trackIndex.end())
                    throw std::runtime_error ("window names unknown track \"" + name + "\"");
                window.source = trackIndex[name];
                window.kind = child.isVoid() ? Window::receivePre : Window::track;
                window.compDelay = (juce::int64) requireNumber (input, "comp_delay", "window");
                if (window.kind == Window::receivePre)
                {
                    if (requireString (input, "tap", "receive window") != "pre")
                        throw std::runtime_error ("receive windows tap pre; post arrives as a track window");
                    tracks[(size_t) window.source].needPre = true;
                }
                if (window.start - window.readOffset < 0)
                    throw std::runtime_error ("live taps only delay (start < read_offset on \""
                                              + track.name + "\")");
            }
            track.windows.push_back (window);
        }

        for (const auto& insert : requireArray (entry, "chain", "track"))
        {
            const auto effect = requireString (insert, "effect", "insert");
            ChainSpec spec;
            if (effect == "eq")
            {
                spec.kind = 0;
                for (const auto& band : requireArray (insert, "bands", "eq insert"))
                {
                    dsp::Band b;
                    b.type = requireString (band, "type", "eq band");
                    b.frequency = requireNumber (band, "frequency", "eq band");
                    b.gainDb = requireNumber (band, "gain_db", "eq band");
                    b.bandwidth = requireNumber (band, "bandwidth", "eq band");
                    spec.bands.push_back (b);
                }
                spec.normalize = (bool) insert.getProperty ("normalize", juce::var (false));
            }
            else if (effect == "limit")
            {
                spec.kind = 1;
                spec.limiter.ceilingDb = requireNumber (insert, "ceiling_db", "limit insert");
                spec.limiter.lookaheadMs = requireNumber (insert, "lookahead_ms", "limit insert");
                spec.limiter.releaseMs = requireNumber (insert, "release_ms", "limit insert");
                spec.limiter.sampleRate = (double) rate;
                spec.horizonDb = requireNumber (insert, "horizon_db", "limit insert");
            }
            else if (effect == "reverb")
            {
                spec.kind = 2;
                spec.reverb.mix = requireNumber (insert, "mix", "reverb insert");
                spec.reverb.decaySeconds = requireNumber (insert, "decay", "reverb insert");
                spec.reverb.predelayMs = requireNumber (insert, "predelay_ms", "reverb insert");
                spec.reverb.damping = requireNumber (insert, "damping", "reverb insert");
                spec.reverb.sampleRate = (double) rate;
            }
            else
            {
                throw std::runtime_error ("unknown insert effect \"" + effect + "\"");
            }
            track.chainSpecs.push_back (std::move (spec));
        }
        buildChain (track);
    }

    // Lengths, computed here from the same facts the compiler used: the
    // content end, grown by each reverb's predelay + T60. The output
    // track streams and needs no buffers; every other track renders once
    // into timeline-aligned buffers on first demand.
    for (int t = 0; t < (int) tracks.size(); ++t)
    {
        Track& track = tracks[(size_t) t];
        juce::int64 contentEnd = 0;
        for (const auto& window : track.windows)
            contentEnd = std::max (contentEnd, window.start + window.duration);
        track.preLength = contentEnd;
        juce::int64 growth = 0;
        for (const auto& stage : track.chain)
            if (stage.reverb != nullptr)
                growth += stage.reverb->tailSamples();
        track.postLength = contentEnd + growth;
        if (t != outputTrack)
        {
            track.post.assign (2, std::vector<float> ((size_t) track.postLength, 0.0f));
            if (track.needPre)
                track.pre.assign (2, std::vector<float> ((size_t) track.preLength, 0.0f));
        }
    }

    // Children render in full here, at load: the memory is already
    // committed to their buffers, and it keeps the audio callback off
    // the heap and out of recursion (Codex's finding on this PR). The
    // scratch below is the callback's only working memory.
    for (int t = 0; t < (int) tracks.size(); ++t)
        if (t != outputTrack)
            produceUntil (t, tracks[(size_t) t].postLength);
    scratchBlock.assign (2, std::vector<float>());
    scratchMixed.assign (2, std::vector<float>());
    for (int c = 0; c < 2; ++c)
    {
        scratchBlock[(size_t) c].reserve (8192);
        scratchMixed[(size_t) c].reserve (8192);
    }
}


void LiveSession::buildChain (Track& track) const
{
    track.chain.clear();
    for (const auto& spec : track.chainSpecs)
    {
        ChainStage stage;
        if (spec.kind == 0)
            stage.eq = std::make_unique<dsp::Eq> (spec.bands, spec.normalize, (double) rate,
                                                  (size_t) 2);
        else if (spec.kind == 1)
            stage.limiter = std::make_unique<dsp::Limiter> (spec.limiter, (size_t) 2,
                                                            spec.horizonDb);
        else
            stage.reverb = std::make_unique<dsp::Reverb> (spec.reverb, (size_t) 2);
        track.chain.push_back (std::move (stage));
    }
}

void LiveSession::mixInputBlock (Track& track,
                                 juce::int64 from,
                                 int n,
                                 std::vector<std::vector<float>>& block,
                                 juce::int64 absoluteFrom)
{
    for (auto& channel : block)
        std::fill (channel.begin(), channel.end(), 0.0f);

    for (auto& window : track.windows)
    {
        const juce::int64 overlapStart = std::max (from, window.start);
        const juce::int64 overlapEnd = std::min (from + n, window.start + window.duration);
        if (overlapEnd <= overlapStart)
            continue;

        // Ensure the child exists as far as this window reads it.
        const juce::int64 maxSource
            = window.readOffset + (overlapEnd - 1 - window.start) - window.compDelay;
        if (window.kind == Window::track)
            produceUntil (window.source,
                          std::min (maxSource + 1, tracks[(size_t) window.source].postLength));
        else if (window.kind == Window::receivePre)
            produceUntil (window.source,
                          std::min (maxSource + 1, tracks[(size_t) window.source].preLength));

        const std::vector<float>* srcL = nullptr;
        const std::vector<float>* srcR = nullptr;
        if (window.kind == Window::file)
        {
            const auto& channels = files[(size_t) window.source];
            srcL = &channels[0];
            srcR = channels.size() > 1 ? &channels[1] : &channels[0];
        }
        else
        {
            const auto& child = tracks[(size_t) window.source];
            const auto& buffers = window.kind == Window::track ? child.post : child.pre;
            srcL = &buffers[0];
            srcR = &buffers[1];
        }

        const double baseGain = std::pow (10.0, window.gainDb / 20.0);
        double balanceL = 1.0, balanceR = 1.0;
        dsp::balanceGains (window.pan, balanceL, balanceR);

        for (juce::int64 at = overlapStart; at < overlapEnd; ++at)
        {
            const juce::int64 i = at - window.start;
            const juce::int64 s = window.readOffset + i - window.compDelay;
            if (s < 0 || (size_t) s >= srcL->size())
                continue;
            double g = baseGain;
            if (window.rampStart >= 0)
            {
                // A dB-linear glide from rampFromDb to gainDb, evaluated
                // on the unwrapped timeline; before it starts, the old
                // value; after, the new one — and after a wrap, still
                // the new one.
                const juce::int64 into = absoluteFrom + (at - from) - window.rampStart;
                const double progress = window.rampLength <= 0
                                            ? 1.0
                                            : std::clamp ((double) into / (double) window.rampLength,
                                                          0.0, 1.0);
                if (into >= 0)
                    g = std::pow (10.0,
                                  (window.rampFromDb
                                   + (window.gainDb - window.rampFromDb) * progress)
                                      / 20.0);
                else
                    g = std::pow (10.0, window.rampFromDb / 20.0);
            }
            if ((double) i < (double) window.fadeIn)
                g *= (double) i / (double) window.fadeIn;
            const double fromEnd = (double) (window.duration - 1 - i);
            if (fromEnd < (double) window.fadeOut)
                g *= fromEnd / (double) window.fadeOut;
            const size_t out = (size_t) (at - from);
            block[0][out]
                = (float) ((double) block[0][out] + (double) (*srcL)[(size_t) s] * g * balanceL);
            block[1][out]
                = (float) ((double) block[1][out] + (double) (*srcR)[(size_t) s] * g * balanceR);
        }
    }
}

void LiveSession::produceUntil (int trackIndexArg, juce::int64 outputSamples)
{
    Track& track = tracks[(size_t) trackIndexArg];
    outputSamples = std::min (outputSamples, track.postLength);
    if (track.produced >= outputSamples)
        return;

    std::vector<std::vector<float>> block (2);
    while (track.produced < outputSamples)
    {
        const int n = (int) std::min<juce::int64> (engineBlock, track.postLength - track.fed > 0
                                                                    ? track.postLength - track.fed
                                                                    : 0);
        if (n <= 0)
            break; // everything fed; nothing further can emerge without a flush
        for (auto& channel : block)
            channel.assign ((size_t) n, 0.0f);
        mixInputBlock (track, track.fed, n, block, track.fed);

        if (track.needPre)
            for (int c = 0; c < 2; ++c)
            {
                const juce::int64 copy
                    = std::min<juce::int64> (n, track.preLength - track.fed);
                for (juce::int64 i = 0; i < copy; ++i)
                    track.pre[(size_t) c][(size_t) (track.fed + i)] = block[(size_t) c][(size_t) i];
            }

        // Through the chain: eq and reverb in place, the limiter emitting
        // what is final (its stream lags; the reverb's tail arrives via
        // the zeros this loop feeds past the content end).
        runChain (track, block, 0);
        track.fed += n;
        if (track.fed >= track.postLength)
            flushChain (track, block);

        const juce::int64 emitCount = (juce::int64) block[0].size();
        for (int c = 0; c < 2; ++c)
            for (juce::int64 i = 0; i < emitCount && track.produced + i < track.postLength; ++i)
                track.post[(size_t) c][(size_t) (track.produced + i)]
                    = block[(size_t) c][(size_t) i];
        track.produced += emitCount;
    }
}

void LiveSession::runChain (Track& track, std::vector<std::vector<float>>& working, size_t fromStage)
{
    for (size_t k = fromStage; k < track.chain.size(); ++k)
    {
        auto& stage = track.chain[k];
        if (stage.eq != nullptr)
            stage.eq->process (working);
        else if (stage.reverb != nullptr)
            stage.reverb->process (working);
        else if (stage.limiter != nullptr)
        {
            std::vector<std::vector<float>> out (2);
            stage.limiter->process (working, out);
            working = std::move (out);
        }
    }
}

void LiveSession::flushChain (Track& track, std::vector<std::vector<float>>& working)
{
    for (size_t k = 0; k < track.chain.size(); ++k)
    {
        auto& stage = track.chain[k];
        if (stage.limiter == nullptr)
            continue;
        std::vector<std::vector<float>> tail (2);
        stage.limiter->flush (tail);
        // What the flush released passes through everything after this
        // stage, exactly as it would have inside a block.
        runChain (track, tail, k + 1);
        for (int c = 0; c < 2; ++c)
            working[(size_t) c].insert (working[(size_t) c].end(), tail[(size_t) c].begin(),
                                        tail[(size_t) c].end());
    }
}

void LiveSession::renderBlock (float* const* out, int numChannels, int n)
{
    Track& output = tracks[(size_t) outputTrack];
    auto& block = scratchBlock;
    for (auto& channel : block)
        channel.assign ((size_t) n, 0.0f);

    // The output streams: wrapped-time input mixing, chains that never
    // reset — the wrap hears the previous pass's tails ring across it,
    // which is the fold as a performance instead of an arithmetic step.
    juce::int64 filled = 0;
    while (filled < n)
    {
        const juce::int64 t = loop && length > 0 ? clock % length : clock;
        const juce::int64 until
            = loop && length > 0 ? length - t : std::max<juce::int64> (1, output.postLength - t);
        const int step = (int) std::min<juce::int64> (n - filled, std::max<juce::int64> (1, until));

        auto& mixed = scratchMixed;
        for (auto& channel : mixed)
            channel.assign ((size_t) step, 0.0f);
        mixInputBlock (output, t, step, mixed, clock);
        runChain (output, mixed, 0);

        for (int c = 0; c < 2; ++c)
            for (size_t i = 0; i < mixed[(size_t) c].size() && filled + (juce::int64) i < n; ++i)
            {
                // A non-looping session truncates at its declared extent
                // exactly as the offline render does — output samples at
                // or past `length` are silence, whatever the chain still
                // holds (Codex's finding on this PR).
                const juce::int64 outAt = delivered + filled + (juce::int64) i;
                const bool past = ! loop && length > 0 && outAt >= length;
                block[(size_t) c][(size_t) (filled + (juce::int64) i)]
                    = past ? 0.0f : mixed[(size_t) c][i];
            }
        filled += (juce::int64) mixed[0].size();
        clock += step;
    }
    // Position is what has been *heard*: the output stream lags the
    // input clock by any limiter window, and finishing early would clip
    // the tail (cursor's finding on this PR).
    delivered += n;

    for (int c = 0; c < numChannels; ++c)
    {
        const auto& src = block[(size_t) std::min (c, 1)];
        for (int i = 0; i < n; ++i)
            out[c][i] = c < 2 ? src[(size_t) i] : 0.0f;
    }
}

void LiveSession::locate (juce::int64 sample)
{
    clock = sample;
    delivered = sample;
    // A seek does not inherit the previous position's tails: the output
    // chain rebuilds from its specs, state zeroed (Codex's finding).
    buildChain (tracks[(size_t) outputTrack]);
}

void LiveSession::ramp (const std::string& trackName, int input, double gainDb, double rampMs)
{
    const auto found = trackIndex.find (trackName);
    if (found == trackIndex.end())
        throw std::runtime_error ("ramp names unknown track \"" + trackName + "\"");
    Track& track = tracks[(size_t) found->second];
    if (input < 0 || (size_t) input >= track.windows.size())
        throw std::runtime_error ("ramp names input " + std::to_string (input) + " of "
                                  + std::to_string (track.windows.size()));
    Window& window = track.windows[(size_t) input];
    window.rampFromDb = window.gainDb;
    window.gainDb = gainDb;
    // On the unwrapped timeline, landing at the next block — wrapped
    // time would resurrect the old gain each pass (Codex's finding). A
    // pre-rendered child re-renders in chunk 3's diffing instead.
    window.rampStart = clock;
    window.rampLength = (juce::int64) std::llround ((rampMs / 1000.0) * (double) rate);
}

std::string runRenderLive (const std::string& sessionPath,
                           const std::string& outputPath,
                           const std::string& rootPath)
{
    try
    {
        const juce::File sessionFile { juce::String (sessionPath) };
        if (! sessionFile.existsAsFile())
            return sessionPath + ": no such session";
        const auto session = juce::JSON::parse (sessionFile.loadFileAsString());
        if (! session.isObject())
            return sessionPath + ": session is not a JSON object";

        LiveSession live (session, juce::File (juce::String (rootPath)));
        // One pass of the declared length. Looping playback is a
        // transport behaviour; the golden compares one pass, and a
        // session without an extent has no "one pass" to compare.
        const juce::int64 total = live.lengthSamples();
        if (total <= 0)
            return sessionPath + ": session declares no length_samples — the golden needs one pass";

        std::vector<std::vector<float>> out (2);
        constexpr int blockSize = 4096;
        std::vector<float> left (blockSize), right (blockSize);
        float* channels[2] = { left.data(), right.data() };
        for (juce::int64 at = 0; at < total; at += blockSize)
        {
            const int n = (int) std::min<juce::int64> (blockSize, total - at);
            live.renderBlock (channels, 2, n);
            out[0].insert (out[0].end(), left.begin(), left.begin() + n);
            out[1].insert (out[1].end(), right.begin(), right.begin() + n);
        }
        dsp::writeWavFloat32 (outputPath, (double) live.sessionRate(), out);
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
}

} // namespace field
