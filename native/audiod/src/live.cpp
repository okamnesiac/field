#include "live.h"

#include "click.h"

#include "dsp/mixdown.h"
#include "dsp/wavfile.h"

#include <algorithm>
#include <cmath>
#include <set>
#include <stdexcept>

namespace field
{
namespace
{
constexpr int liveSessionVersion = 4; // session.ts SESSION_VERSION
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

void reserveAll (std::vector<std::vector<float>>& channels, size_t frames)
{
    for (auto& channel : channels)
        channel.reserve (frames);
}

// A file played as an input: what --render-live feeds an input window,
// then silence.
class FileInput final : public LiveInput
{
public:
    explicit FileInput (std::vector<std::vector<float>> channelsIn) : channels (std::move (channelsIn)) {}

    void read (float* left, float* right, int n) override
    {
        const auto& l = channels[0];
        const auto& r = channels.size() > 1 ? channels[1] : channels[0];
        for (int i = 0; i < n; ++i, ++at)
        {
            left[i] = at < l.size() ? l[at] : 0.0f;
            right[i] = at < r.size() ? r[at] : 0.0f;
        }
    }

private:
    std::vector<std::vector<float>> channels;
    size_t at = 0;
};

} // namespace

LiveSession::LiveSession (const juce::var& session, const juce::File& projectRoot, const LiveInputs& inputs)
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
        // A foreign rate is legal since session version 2: the track
        // evaluates at its own rate and every consuming edge converts
        // (cross-rate-live.md decision 1).
        track.rate = (int) requireNumber (entry, "rate", "track");
        trackIndex[track.name] = (int) tracks.size();
        tracks.push_back (std::move (track));
    }

    const auto outputName = requireString (session, "output", "session");
    if (trackIndex.find (outputName) == trackIndex.end())
        throw std::runtime_error ("session output \"" + outputName + "\" is not a track");
    outputTrack = trackIndex[outputName];

    // Second pass: windows, chains, buffers.
    std::map<std::string, int> fileIndex;
    std::set<std::string> inputNames;
    for (int t = 0; t < (int) trackArray.size(); ++t)
    {
        const auto& entry = trackArray.getReference (t);
        Track& track = tracks[(size_t) t];

        for (const auto& input : requireArray (entry, "inputs", "track"))
        {
            Window window;
            const auto inputName = input.getProperty ("input", juce::var());
            if (! inputName.isVoid())
            {
                // A live input (live-supercollider.md §2): a gain and a
                // pan, and no place on the timeline — the overlay
                // carries it (§9).
                window.kind = Window::input;
                window.gainDb = requireNumber (input, "gain_db", "input window");
                const auto inputPan = input.getProperty ("pan", juce::var());
                window.pan = inputPan.isVoid() ? 0.0 : (double) inputPan;
                const auto name = inputName.toString().toStdString();
                const auto fed = inputs.find (name);
                if (fed == inputs.end() || fed->second == nullptr)
                    throw std::runtime_error ("session names input \"" + name + "\", which nothing feeds");
                if (! inputNames.insert (name).second)
                    throw std::runtime_error ("input \"" + name + "\" is named twice");
                if (track.rate != rate)
                    throw std::runtime_error ("input \"" + name + "\" is on \"" + track.name + "\" at "
                                              + std::to_string (track.rate) + " Hz; an input plays at the session's "
                                              + std::to_string (rate) + " Hz");
                window.source = (int) inputSources.size();
                inputSources.push_back (fed->second);
                track.windows.push_back (window);
                continue;
            }
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
                spec.limiter.sampleRate = (double) track.rate;
                spec.horizonDb = requireNumber (insert, "horizon_db", "limit insert");
            }
            else if (effect == "reverb")
            {
                spec.kind = 2;
                spec.reverb.mix = requireNumber (insert, "mix", "reverb insert");
                spec.reverb.decaySeconds = requireNumber (insert, "decay", "reverb insert");
                spec.reverb.predelayMs = requireNumber (insert, "predelay_ms", "reverb insert");
                spec.reverb.damping = requireNumber (insert, "damping", "reverb insert");
                spec.reverb.sampleRate = (double) track.rate;
            }
            else if (effect == "plate")
            {
                spec.kind = 3;
                spec.plate.mix = requireNumber (insert, "mix", "plate insert");
                spec.plate.decaySeconds = requireNumber (insert, "decay", "plate insert");
                spec.plate.predelayMs = requireNumber (insert, "predelay_ms", "plate insert");
                spec.plate.damping = requireNumber (insert, "damping", "plate insert");
                spec.plate.diffusion = requireNumber (insert, "diffusion", "plate insert");
                spec.plate.modulation = requireNumber (insert, "modulation", "plate insert");
                spec.plate.sampleRate = (double) track.rate;
            }
            else if (effect == "hall")
            {
                spec.kind = 4;
                spec.hall.mix = requireNumber (insert, "mix", "hall insert");
                spec.hall.decaySeconds = requireNumber (insert, "decay", "hall insert");
                spec.hall.decayLow = requireNumber (insert, "decay_low", "hall insert");
                spec.hall.decayHigh = requireNumber (insert, "decay_high", "hall insert");
                spec.hall.size = requireNumber (insert, "size", "hall insert");
                spec.hall.predelayMs = requireNumber (insert, "predelay_ms", "hall insert");
                spec.hall.diffusion = requireNumber (insert, "diffusion", "hall insert");
                spec.hall.modulation = requireNumber (insert, "modulation", "hall insert");
                spec.hall.width = requireNumber (insert, "width", "hall insert");
                spec.hall.sampleRate = (double) track.rate;
            }
            else if (effect == "plugin")
            {
                // A hosted insert (plugin-hosting.md chunk 2), in the
                // offline wire spelling. Instantiation happens in
                // buildChain below — the load thread — never in the
                // callback.
                spec.kind = 5;
                spec.plugin.format = requireString (insert, "format", "plugin insert");
                spec.plugin.identifier = requireString (insert, "identifier", "plugin insert");
                spec.plugin.name = requireString (insert, "name", "plugin insert");
                spec.plugin.version = requireString (insert, "version", "plugin insert");
                spec.plugin.latency
                    = (juce::int64) requireNumber (insert, "latency", "plugin insert");
                const auto tail = insert.getProperty ("tail", juce::var());
                if (tail.isDouble() || tail.isInt() || tail.isInt64())
                    spec.plugin.tailSeconds = (double) tail;
                spec.plugin.statePath
                    = insert.getProperty ("state_path", juce::var()).toString().toStdString();
                spec.plugin.pathHint
                    = insert.getProperty ("path", juce::var()).toString().toStdString();
                spec.plugin.params = insert.getProperty ("params", juce::var());
                for (const auto& segment :
                     requireArray (insert.getProperty ("transport", juce::var()), "segments",
                                   "plugin transport"))
                {
                    TrackPlayHead::Segment s;
                    s.sample = (juce::int64) requireNumber (segment, "sample", "tempo segment");
                    s.ppq = requireNumber (segment, "ppq", "tempo segment");
                    s.bpm = requireNumber (segment, "bpm", "tempo segment");
                    s.numerator = (int) requireNumber (segment, "numerator", "tempo segment");
                    s.denominator = (int) requireNumber (segment, "denominator", "tempo segment");
                    spec.plugin.segments.push_back (s);
                }
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
        {
            if (stage.reverb != nullptr)
                growth += stage.reverb->tailSamples();
            else if (stage.plate != nullptr)
                growth += stage.plate->tailSamples();
            else if (stage.hall != nullptr)
                growth += stage.hall->tailSamples();
            else if (stage.plugin != nullptr)
                growth += stage.plugin->tailSamples();
        }
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
    // Every cross-rate edge's conversion exists before the callback
    // runs: the pre-render recursion above built the ones children
    // consume, and this pass covers the output track's own windows.
    // After load, mixInputBlock's ensure is a map lookup.
    for (const auto& track : tracks)
        for (const auto& window : track.windows)
            if (window.kind != Window::file && window.kind != Window::input
                && tracks[(size_t) window.source].rate != track.rate)
                ensureConverted (window.source, track.rate,
                                 window.kind == Window::receivePre);
    scratchBlock.assign (2, std::vector<float>());
    scratchMixed.assign (2, std::vector<float>());
    for (int c = 0; c < 2; ++c)
    {
        scratchBlock[(size_t) c].reserve (8192);
        scratchMixed[(size_t) c].reserve (8192);
    }
    outputPending.assign (2, std::vector<float>());
    primeOutput();
    buildOverlay();
}

void LiveSession::buildOverlay()
{
    const int count = (int) tracks.size();
    const auto reads = [] (const Window& window, const std::vector<bool>& set)
    {
        return window.kind != Window::file && window.kind != Window::input
               && set[(size_t) window.source];
    };
    // What an input reaches: its track, then upward to a fixed point
    // through every window that places or receives a track on it.
    std::vector<bool> live ((size_t) count, false);
    for (int t = 0; t < count; ++t)
        for (const auto& window : tracks[(size_t) t].windows)
            if (window.kind == Window::input)
                live[(size_t) t] = true;
    for (bool grew = true; grew;)
    {
        grew = false;
        for (int t = 0; t < count; ++t)
            if (! live[(size_t) t])
                for (const auto& window : tracks[(size_t) t].windows)
                    if (reads (window, live))
                    {
                        live[(size_t) t] = grew = true;
                        break;
                    }
    }

    // Children before the tracks that read them: a track joins once
    // every live track it reads has. Placement cycles never validate,
    // so every live track joins.
    overlayIndex.assign ((size_t) count, -1);
    std::vector<bool> joined ((size_t) count, false);
    for (bool grew = true; grew;)
    {
        grew = false;
        for (int t = 0; t < count; ++t)
        {
            if (! live[(size_t) t] || joined[(size_t) t])
                continue;
            Track& track = tracks[(size_t) t];
            bool ready = true;
            for (const auto& window : track.windows)
                if (reads (window, live) && ! joined[(size_t) window.source])
                    ready = false;
            if (! ready)
                continue;

            OverlayTrack slot;
            slot.track = t;
            std::set<std::pair<int, bool>> placed;
            for (int w = 0; w < (int) track.windows.size(); ++w)
            {
                const auto& window = track.windows[(size_t) w];
                if (window.kind == Window::input)
                {
                    OverlayInput input;
                    input.window = w;
                    slot.inputs.push_back (std::move (input));
                    continue;
                }
                if (! reads (window, live))
                    continue;
                // Once per child and tap: the input is heard once,
                // through the first window placing its track (§9).
                const bool pre = window.kind == Window::receivePre;
                if (! placed.insert ({ window.source, pre }).second)
                    continue;
                if (tracks[(size_t) window.source].rate != track.rate)
                    throw std::runtime_error ("a live input crosses from \""
                                              + tracks[(size_t) window.source].name + "\" into \""
                                              + track.name + "\" at another rate; an input's path needs one rate");
                OverlayEdge edge;
                edge.child = window.source;
                edge.window = w;
                edge.pre = pre;
                slot.edges.push_back (std::move (edge));
            }

            // Align every feed to the latest: an input arrives at once, a
            // pre-tap edge as late as what reached its child, a post edge
            // that plus its child's chain.
            const auto arrival = [this] (const OverlayEdge& edge)
            {
                const auto& from = overlay[(size_t) overlayIndex[(size_t) edge.child]];
                return edge.pre ? from.inLatency : from.outLatency;
            };
            for (const auto& edge : slot.edges)
                slot.inLatency = std::max (slot.inLatency, arrival (edge));
            const auto prepare = [] (DelayLine& delay, juce::int64 samples)
            {
                delay.samples = samples;
                delay.line.assign (2, std::vector<float> ((size_t) samples, 0.0f));
                delay.out.assign (2, std::vector<float>());
                reserveAll (delay.line, (size_t) samples + 16384);
                reserveAll (delay.out, 16384);
            };
            for (auto& input : slot.inputs)
                prepare (input.delay, slot.inLatency);
            for (auto& edge : slot.edges)
                prepare (edge.delay, slot.inLatency - arrival (edge));

            juce::int64 latency = 0;
            if (t != outputTrack)
            {
                buildStages (slot.chain, track.chainSpecs, track.rate, 0);
                for (const auto& stage : slot.chain)
                    if (stage.limiter != nullptr)
                        latency += stage.limiter->latencySamples();
                    else if (stage.plugin != nullptr)
                        latency += stage.plugin->latencySamples();
            }
            slot.outLatency = slot.inLatency + latency;
            slot.pre.assign (2, std::vector<float>());
            slot.post.assign (2, std::vector<float>());
            slot.delayed.assign (2, std::vector<float> ((size_t) latency, 0.0f));
            reserveAll (slot.pre, 16384);
            reserveAll (slot.post, 16384);
            reserveAll (slot.delayed, (size_t) latency + 16384);
            overlayIndex[(size_t) t] = (int) overlay.size();
            overlay.push_back (std::move (slot));
            joined[(size_t) t] = grew = true;
        }
    }
    if (! overlay.empty())
        inputScratch.assign (2, std::vector<float> (8192, 0.0f));
    if (overlayIndex[(size_t) outputTrack] >= 0)
    {
        const Track& output = tracks[(size_t) outputTrack];
        buildStages (idleChain, output.chainSpecs, output.rate, 0);
        juce::int64 latency = 0;
        for (const auto& stage : idleChain)
            if (stage.limiter != nullptr)
                latency += stage.limiter->latencySamples();
            else if (stage.plugin != nullptr)
                latency += stage.plugin->latencySamples();
        idleBlock.assign (2, std::vector<float>());
        idleDelayed.assign (2, std::vector<float> ((size_t) latency, 0.0f));
        reserveAll (idleBlock, 16384);
        reserveAll (idleDelayed, (size_t) latency + 16384);
    }
}

void LiveSession::renderIdle (float* const* out, int numChannels, int n)
{
    const int slot = overlay.empty() ? -1 : overlayIndex[(size_t) outputTrack];
    if (slot < 0)
    {
        for (int c = 0; c < numChannels; ++c)
            std::fill (out[c], out[c] + n, 0.0f);
        return;
    }
    // The song's clock does not move while stopped; the overlay's does,
    // so a ramp on a window the input passes through still glides.
    renderOverlay (n);
    const auto& mixed = overlay[(size_t) slot].post;
    for (int c = 0; c < 2; ++c)
        idleBlock[(size_t) c].assign (mixed[(size_t) c].begin(), mixed[(size_t) c].begin() + n);
    runStages (idleChain, idleBlock, 0);
    for (int c = 0; c < 2; ++c)
    {
        auto& delayed = idleDelayed[(size_t) c];
        delayed.insert (delayed.end(), idleBlock[(size_t) c].begin(), idleBlock[(size_t) c].end());
    }
    for (int c = 0; c < numChannels; ++c)
        for (int i = 0; i < n; ++i)
            out[c][i] = c < 2 ? idleDelayed[(size_t) c][(size_t) i] : 0.0f;
    for (auto& delayed : idleDelayed)
        delayed.erase (delayed.begin(), delayed.begin() + n);
}

// A feed through its delay line: the block that leaves it now, which is
// the block that came in `samples` ago.
static void passThrough (std::vector<std::vector<float>>& line,
                         std::vector<std::vector<float>>& out,
                         juce::int64 samples,
                         const float* left,
                         const float* right,
                         int n,
                         const float*& leftOut,
                         const float*& rightOut)
{
    if (samples == 0)
    {
        leftOut = left;
        rightOut = right;
        return;
    }
    const float* in[2] = { left, right };
    for (int c = 0; c < 2; ++c)
    {
        line[(size_t) c].insert (line[(size_t) c].end(), in[c], in[c] + n);
        out[(size_t) c].assign (line[(size_t) c].begin(), line[(size_t) c].begin() + n);
        line[(size_t) c].erase (line[(size_t) c].begin(), line[(size_t) c].begin() + n);
    }
    leftOut = out[0].data();
    rightOut = out[1].data();
}

void LiveSession::renderOverlay (int n)
{
    if (inputScratch[0].size() < (size_t) n)
        for (auto& channel : inputScratch)
            channel.resize ((size_t) n, 0.0f);
    // mixInputBlock's arithmetic without the fades: double accumulation,
    // the same balance law, and a ramp's glide sample by sample, so an
    // input adds exactly what a file window with its samples would.
    const auto add = [&] (std::vector<std::vector<float>>& block, const Window& window, const float* left,
                          const float* right)
    {
        const double baseGain = std::pow (10.0, window.gainDb / 20.0);
        double balanceL = 1.0, balanceR = 1.0;
        dsp::balanceGains (window.pan, balanceL, balanceR);
        for (int i = 0; i < n; ++i)
        {
            const double g = window.overlayRampStart < 0
                                 ? baseGain
                                 : glide (window, overlayClock + i - window.overlayRampStart);
            block[0][(size_t) i] = (float) ((double) block[0][(size_t) i] + (double) left[i] * g * balanceL);
            block[1][(size_t) i] = (float) ((double) block[1][(size_t) i] + (double) right[i] * g * balanceR);
        }
    };
    for (auto& slot : overlay)
    {
        Track& track = tracks[(size_t) slot.track];
        for (auto& channel : slot.post)
            channel.assign ((size_t) n, 0.0f);
        float* left = inputScratch[0].data();
        float* right = inputScratch[1].data();
        for (auto& input : slot.inputs)
        {
            const Window& window = track.windows[(size_t) input.window];
            if (overlayReadsInputs)
                inputSources[(size_t) window.source]->read (left, right, n);
            else
            {
                std::fill (left, left + n, 0.0f);
                std::fill (right, right + n, 0.0f);
            }
            const float* l = nullptr;
            const float* r = nullptr;
            passThrough (input.delay.line, input.delay.out, input.delay.samples, left, right, n, l, r);
            add (slot.post, window, l, r);
        }
        for (auto& edge : slot.edges)
        {
            const auto& from = overlay[(size_t) overlayIndex[(size_t) edge.child]];
            const auto& source = edge.pre ? from.pre : from.post;
            const float* l = nullptr;
            const float* r = nullptr;
            passThrough (edge.delay.line, edge.delay.out, edge.delay.samples, source[0].data(), source[1].data(), n,
                         l, r);
            add (slot.post, track.windows[(size_t) edge.window], l, r);
        }
        // The output track's own chain runs on the true sum in renderBlock.
        if (slot.track == outputTrack)
            continue;
        for (int c = 0; c < 2; ++c)
            slot.pre[(size_t) c].assign (slot.post[(size_t) c].begin(), slot.post[(size_t) c].end());
        runStages (slot.chain, slot.post, 0);
        for (int c = 0; c < 2; ++c)
        {
            auto& delayed = slot.delayed[(size_t) c];
            auto& post = slot.post[(size_t) c];
            delayed.insert (delayed.end(), post.begin(), post.end());
            post.assign (delayed.begin(), delayed.begin() + n);
            delayed.erase (delayed.begin(), delayed.begin() + n);
        }
    }    overlayClock += n;
}

void LiveSession::primeOutput()
{
    Track& output = tracks[(size_t) outputTrack];
    juce::int64 prime = 0;
    for (const auto& stage : output.chain)
        if (stage.plugin != nullptr)
            prime += stage.plugin->latencySamples();
    if (prime <= 0)
        return;

    // The renderBlock inner loop, run at load for the first `prime`
    // input samples: the hosted stages swallow their latency windows
    // here, and the few samples that do emerge (a limiter downstream of
    // a plugin has its own arithmetic) wait in outputPending.
    std::vector<std::vector<float>> mixed (2);
    juce::int64 fedPrime = 0;
    while (fedPrime < prime)
    {
        const juce::int64 t = loop && length > 0 ? clock % length : clock;
        const juce::int64 until
            = loop && length > 0 ? length - t : std::max<juce::int64> (1, output.postLength - t);
        const int step = (int) std::min<juce::int64> (
            std::min<juce::int64> ((juce::int64) engineBlock, prime - fedPrime),
            std::max<juce::int64> (1, until));
        for (auto& channel : mixed)
            channel.assign ((size_t) step, 0.0f);
        mixInputBlock (output, t, step, mixed, clock);
        runChain (output, mixed, 0);
        for (int c = 0; c < 2; ++c)
            outputPending[(size_t) c].insert (outputPending[(size_t) c].end(),
                                              mixed[(size_t) c].begin(),
                                              mixed[(size_t) c].end());
        clock += step;
        fedPrime += step;
    }
}


void LiveSession::buildChain (Track& track, juce::int64 startClock) const
{
    buildStages (track.chain, track.chainSpecs, track.rate, startClock);
}

void LiveSession::buildStages (std::vector<ChainStage>& chain,
                               const std::vector<ChainSpec>& specs,
                               int trackRate,
                               juce::int64 startClock) const
{
    // Hosted stages survive the rebuild: a locate runs under liveLock,
    // where reinstantiation — binary load, state blob from disk,
    // prepareToPlay — is measured in dropped audio, not milliseconds
    // (minjudd's P2 on #150, the argument that already moved session
    // construction and converter prep outside that lock). Specs never
    // change after load, so surviving stages pair with their specs by
    // order; reset() zeroes processing state, and the far-seek warmup
    // carries the same −60 dB claim it always made for hosted arms.
    std::vector<std::unique_ptr<LivePluginStage>> surviving;
    for (auto& stage : chain)
        if (stage.plugin != nullptr)
            surviving.push_back (std::move (stage.plugin));
    size_t reused = 0;
    chain.clear();
    for (const auto& spec : specs)
    {
        ChainStage stage;
        if (spec.kind == 0)
            // The track's own rate, not the session's: a foreign-rate
            // track's chain runs on its own clock, exactly as its
            // offline stem does.
            stage.eq = std::make_unique<dsp::Eq> (spec.bands, spec.normalize,
                                                  (double) trackRate, (size_t) 2);
        else if (spec.kind == 1)
        {
            stage.limiter = std::make_unique<dsp::Limiter> (spec.limiter, (size_t) 2,
                                                            spec.horizonDb);
            stage.scratch.assign (2, std::vector<float>());
            reserveAll (stage.scratch, 16384 + (size_t) stage.limiter->latencySamples());
        }
        else if (spec.kind == 2)
            stage.reverb = std::make_unique<dsp::Reverb> (spec.reverb, (size_t) 2);
        else if (spec.kind == 3)
        {
            stage.plate = std::make_unique<dsp::Plate> (spec.plate, (size_t) 2);
            stage.plate->startAt (startClock);
        }
        else if (spec.kind == 4)
        {
            stage.hall = std::make_unique<dsp::Hall> (spec.hall, (size_t) 2);
            stage.hall->startAt (startClock);
        }
        else
        {
            if (reused < surviving.size())
            {
                stage.plugin = std::move (surviving[reused++]);
                stage.plugin->reset();
            }
            else
            {
                // Load-thread instantiation (state → params → prepare →
                // latency verify inside), once per session — only the
                // constructor's first build reaches here. Prepared at
                // the same 512-sample recipe the scan and the offline
                // render use — a plugin that derives its latency from
                // the prepared maximum must see the environment its
                // `latency:` was pinned under (#150 review) — and the
                // stage splits any larger block down to it.
                stage.plugin = std::make_unique<LivePluginStage> (spec.plugin,
                                                                  (double) trackRate, 512);
            }
            stage.plugin->startAt (startClock);
        }
        chain.push_back (std::move (stage));
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
        if (window.kind == Window::input)
            continue; // the overlay carries it (§9)
        const juce::int64 overlapStart = std::max (from, window.start);
        const juce::int64 overlapEnd = std::min (from + n, window.start + window.duration);
        if (overlapEnd <= overlapStart)
            continue;

        // Ensure the child exists as far as this window reads it. A
        // cross-rate child converts wholesale instead (the window's
        // indices are in this track's rate, the child's buffer in its
        // own); after load the ensure is a map lookup — the constructor
        // built every conversion off the audio thread.
        const bool cross = window.kind != Window::file
                           && tracks[(size_t) window.source].rate != track.rate;
        const juce::int64 maxSource
            = window.readOffset + (overlapEnd - 1 - window.start) - window.compDelay;
        if (cross)
            ensureConverted (window.source, track.rate, window.kind == Window::receivePre);
        else if (window.kind == Window::track)
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
            auto& child = tracks[(size_t) window.source];
            const auto& buffers
                = window.kind == Window::track
                      ? (cross ? child.postConverted.at (track.rate) : child.post)
                      : (cross ? child.preConverted.at (track.rate) : child.pre);
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
            double g = rampedGain (window, absoluteFrom + (at - from), baseGain);
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

double LiveSession::rampedGain (const Window& window, juce::int64 absoluteAt, double baseGain)
{
    if (window.rampStart < 0)
        return baseGain;
    // Evaluated on the unwrapped timeline, so after a wrap the new value
    // holds.
    return glide (window, absoluteAt - window.rampStart);
}

double LiveSession::glide (const Window& window, juce::int64 into)
{
    // A dB-linear glide from rampFromDb to gainDb: before it starts, the
    // old value; after, the new one.
    const double progress = window.rampLength <= 0
                                ? 1.0
                                : std::clamp ((double) into / (double) window.rampLength, 0.0, 1.0);
    if (into >= 0)
        return std::pow (10.0, (window.rampFromDb + (window.gainDb - window.rampFromDb) * progress) / 20.0);
    return std::pow (10.0, window.rampFromDb / 20.0);
}

void LiveSession::ensureConverted (int trackIndexArg, int targetRate, bool pre)
{
    Track& child = tracks[(size_t) trackIndexArg];
    auto& slot = pre ? child.preConverted : child.postConverted;
    if (slot.find (targetRate) != slot.end())
        return;
    // The whole child first (it pre-renders in full at load anyway),
    // then one wholesale pass through the offline wrapper — the same
    // kernel on the same samples the offline convert node runs, which
    // is what makes the edge bit-identical to the offline render
    // (cross-rate-live.md decision 1). Message thread only; the
    // constructor's eager pass guarantees the callback always finds
    // the map populated.
    produceUntil (trackIndexArg, child.postLength);
    slot[targetRate] = dsp::resample (pre ? child.pre : child.post,
                                      (double) child.rate, (double) targetRate);
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
    runStages (track.chain, working, fromStage);
}

void LiveSession::runStages (std::vector<ChainStage>& chain,
                             std::vector<std::vector<float>>& working,
                             size_t fromStage)
{
    for (size_t k = fromStage; k < chain.size(); ++k)
    {
        auto& stage = chain[k];
        if (stage.eq != nullptr)
            stage.eq->process (working);
        else if (stage.reverb != nullptr)
            stage.reverb->process (working);
        else if (stage.plate != nullptr)
            stage.plate->process (working);
        else if (stage.hall != nullptr)
            stage.hall->process (working);
        else if (stage.plugin != nullptr)
            stage.plugin->process (working);
        else if (stage.limiter != nullptr)
        {
            // Into the stage's own buffers, reserved at build, and back:
            // the callback never allocates for a limiter.
            for (auto& channel : stage.scratch)
                channel.clear();
            stage.limiter->process (working, stage.scratch);
            for (size_t c = 0; c < working.size(); ++c)
                working[c].assign (stage.scratch[c].begin(), stage.scratch[c].end());
        }
    }
}

void LiveSession::flushChain (Track& track, std::vector<std::vector<float>>& working)
{
    for (size_t k = 0; k < track.chain.size(); ++k)
    {
        auto& stage = track.chain[k];
        if (stage.limiter == nullptr && stage.plugin == nullptr)
            continue;
        std::vector<std::vector<float>> tail (2);
        if (stage.limiter != nullptr)
            stage.limiter->flush (tail);
        else
            stage.plugin->flush (tail);
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

    // Primed output first (primeOutput's leftovers): samples the load
    // already rendered, belonging at the very front of the stream.
    juce::int64 filled = 0;
    while (filled < n && pendingRead < outputPending[0].size())
    {
        for (int c = 0; c < 2; ++c)
            block[(size_t) c][(size_t) filled] = outputPending[(size_t) c][pendingRead];
        ++pendingRead;
        ++filled;
    }
    if (pendingRead > 0 && pendingRead >= outputPending[0].size())
    {
        for (auto& channel : outputPending)
            channel.clear();
        pendingRead = 0;
    }

    // The output streams: wrapped-time input mixing, chains that never
    // reset — the wrap hears the previous pass's tails ring across it,
    // which is the fold as a performance instead of an arithmetic step.
    // A region loop wraps the same way between its own bounds.
    while (filled < n)
    {
        const bool region = loopTo > loopFrom && clock >= loopFrom;
        const juce::int64 t = region ? wrap (clock) : loop && length > 0 ? clock % length : clock;
        // A step ends only where the clock wraps. With nothing to wrap
        // the block renders whole, past the output's content too: a
        // chain cannot tell the difference, and a live input reads whole
        // blocks instead of one frame at a time.
        const juce::int64 until = region ? loopTo - t : loop && length > 0 ? length - t : n - filled;
        const int step = (int) std::min<juce::int64> (n - filled, std::max<juce::int64> (1, until));

        auto& mixed = scratchMixed;
        for (auto& channel : mixed)
            channel.assign ((size_t) step, 0.0f);
        mixInputBlock (output, t, step, mixed, clock);
        if (! overlay.empty())
        {
            // What the inputs reach, added before the output's chain so
            // its inserts hear the true sum (§9).
            renderOverlay (step);
            if (const int slot = overlayIndex[(size_t) outputTrack]; slot >= 0)
                for (int c = 0; c < 2; ++c)
                    for (int i = 0; i < step; ++i)
                        mixed[(size_t) c][(size_t) i]
                            = (float) ((double) mixed[(size_t) c][(size_t) i]
                                       + (double) overlay[(size_t) slot].post[(size_t) c][(size_t) i]);
        }
        runChain (output, mixed, 0);

        for (int c = 0; c < 2; ++c)
            for (size_t i = 0; i < mixed[(size_t) c].size() && filled + (juce::int64) i < n; ++i)
            {
                // A non-looping session truncates at its declared extent
                // exactly as the offline render does — output samples at
                // or past `length` are silence, whatever the chain still
                // holds (Codex's finding on this PR).
                const juce::int64 outAt = delivered + filled + (juce::int64) i;
                const bool past = ! loop && loopTo <= loopFrom && length > 0 && outAt >= length;
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

// How much history the chain must hear before its state at a position
// matches a from-the-start render within the design's own audibility
// threshold — 60 dB, the figure the limiter horizon and a reverb's T60
// already rest on. A reverb remembers one tail, a limiter one window,
// and a biquad's ring-down at audio settings sits well inside the
// second an eq stage is allowed here.
juce::int64 LiveSession::chainWarmup (const Track& track) const
{
    juce::int64 warmup = 0;
    for (const auto& stage : track.chain)
    {
        if (stage.reverb != nullptr)
            warmup += stage.reverb->tailSamples();
        else if (stage.plate != nullptr)
            warmup += stage.plate->tailSamples();
        else if (stage.hall != nullptr)
            warmup += stage.hall->tailSamples();
        else if (stage.limiter != nullptr)
            warmup += stage.limiter->latencySamples();
        else if (stage.plugin != nullptr)
            // Declared tail plus the latency window, plus the same
            // one-second floor an eq gets: a hosted plugin's internal
            // memory (an undeclared ring, a filter's decay) has no
            // analytic form, and the warmup bound is the only claim the
            // freeze swap makes for hosted arms.
            warmup += stage.plugin->tailSamples() + stage.plugin->latencySamples() + rate;
        else
            warmup += rate;
    }
    return warmup;
}

void LiveSession::discardUntil (juce::int64 sample)
{
    std::vector<std::vector<float>> sink (2, std::vector<float> ((size_t) engineBlock, 0.0f));
    float* outs[2] = { sink[0].data(), sink[1].data() };
    const bool reading = overlayReadsInputs;
    overlayReadsInputs = false;
    while (delivered < sample)
        renderBlock (outs, 2, (int) std::min<juce::int64> (engineBlock, sample - delivered));
    overlayReadsInputs = reading;
}

void LiveSession::locate (juce::int64 sample)
{
    // A short forward move keeps the chain and just renders up to the
    // target — real state, not approximation. This is the swap's second
    // locate (the drift between the pre-roll outside the lock and the
    // transport read under it), and a nearby manual seek gets the same
    // continuity for free.
    Track& output = tracks[(size_t) outputTrack];
    const juce::int64 warmup = chainWarmup (output);
    if (sample < delivered || sample - delivered > warmup)
    {
        // A far seek does not inherit the previous position's tails:
        // the chain rebuilds from its specs, state zeroed (Codex's
        // finding on #138) — and then warms up, rendering the warmup
        // span into the void so the first audible samples carry the
        // reverb tails and limiter state the position implies instead
        // of a cold start's discontinuity (Codex's finding on #139).
        // Clamped at zero: state before the top does not exist, and a
        // looping session's wrap is close enough to a top for a carry
        // landing just past it.
        const juce::int64 from = std::max<juce::int64> (0, sample - warmup);
        buildChain (output, from);
        clock = from;
        delivered = from;
        // Stale primed samples describe the pre-seek timeline; the
        // warmup render below is this position's priming, and it runs
        // on this (message) thread where the deadline does not exist.
        for (auto& channel : outputPending)
            channel.clear();
        pendingRead = 0;
    }
    discardUntil (sample);
}

juce::int64 LiveSession::extentSamples() const
{
    return length > 0 ? length : tracks[(size_t) outputTrack].postLength;
}

juce::int64 LiveSession::wrap (juce::int64 unwrapped) const
{
    if (loopTo > loopFrom && unwrapped >= loopFrom)
        return loopFrom + (unwrapped - loopFrom) % (loopTo - loopFrom);
    if (loop && length > 0)
        return unwrapped % length;
    return unwrapped;
}

void LiveSession::setLoopRegion (juce::int64 from, juce::int64 to)
{
    if (from == to)
    {
        loopFrom = loopTo = 0;
        return;
    }
    if (from < 0 || to <= from)
        throw std::runtime_error ("loop region needs 0 <= from < to");
    if (to > extentSamples())
        throw std::runtime_error ("loop region ends past the session's content ("
                                  + std::to_string (extentSamples()) + " samples)");
    loopFrom = from;
    loopTo = to;
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
    window.overlayRampStart = overlayClock;
    window.rampLength = (juce::int64) std::llround ((rampMs / 1000.0) * (double) rate);
}

std::string runRenderLive (const std::string& sessionPath,
                           const std::string& outputPath,
                           const std::string& rootPath,
                           const std::string& clickPath,
                           const std::vector<std::string>& inputFiles)
{
    try
    {
        const juce::File sessionFile { juce::String (sessionPath) };
        if (! sessionFile.existsAsFile())
            return sessionPath + ": no such session";
        const auto session = juce::JSON::parse (sessionFile.loadFileAsString());
        if (! session.isObject())
            return sessionPath + ": session is not a JSON object";
        Click click;
        if (! clickPath.empty())
        {
            const juce::File clickFile { juce::String (clickPath) };
            if (! clickFile.existsAsFile())
                return clickPath + ": no such click schedule";
            click.setSchedule (juce::JSON::parse (clickFile.loadFileAsString()));
        }

        LiveInputs inputs;
        for (const auto& spec : inputFiles)
        {
            const auto equals = spec.find ('=');
            if (equals == std::string::npos || equals == 0)
                return "--input wants name=file.wav, not \"" + spec + "\"";
            const auto path = juce::File (juce::String (rootPath))
                                  .getChildFile (juce::String (spec.substr (equals + 1)))
                                  .getFullPathName()
                                  .toStdString();
            inputs[spec.substr (0, equals)] = std::make_shared<FileInput> (dsp::readWav (path).channels);
        }
        LiveSession live (session, juce::File (juce::String (rootPath)), inputs);
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
            click.render (at, (double) live.sessionRate(), channels, 2, n);
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
