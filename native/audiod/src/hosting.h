// Hosted plugins (plugin-hosting.md chunk 1): scanning, probing, and the
// offline render arm. Everything here runs in subprocesses — the probe
// because a crashy plugin must not kill the scan, the render because
// that is where --render already lives (render-pipeline.md decision 6).
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <string>
#include <vector>

namespace field
{
// The track-local playhead (plugin-hosting.md decision 13): position
// advances on the chain's own sample clock, tempo and meter come from
// the plan's transport segments, and both render paths supply exactly
// this. No loop or play/stop state exists — a stem renders as one
// linear pass, and the live output's unwrapped clock keeps counting
// across a wrap for the same reason the reverbs' LFO phase does.
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

    juce::Optional<PositionInfo> getPosition() const override;
};

// One hosted insert as a streaming chain stage (plugin-hosting.md
// chunk 2). Construction instantiates on the message thread — identity,
// state, params, prepare, latency verify, the offline order exactly —
// marshalled there when the caller is elsewhere, so it belongs on the
// load thread, never in the callback, and the caller must not hold the
// MessageManagerLock (it would wait on its own lock; the constructor
// refuses loudly instead — minjudd's P1 on #150). Processing
// splits at tempo-segment boundaries like the offline arm, which keeps
// the playhead a pure function of sample position; the stream lags by
// the declared latency (the limiter's contract) and flush() releases
// that window.
class LivePluginStage
{
public:
    struct Spec
    {
        std::string format;
        std::string identifier;
        std::string name;
        std::string version;
        juce::int64 latency = 0;
        double tailSeconds = 0.0; // declared; 0 when absent
        std::string statePath; // empty = none
        std::string pathHint;
        juce::var params; // the wire params array
        std::vector<TrackPlayHead::Segment> segments;
    };

    LivePluginStage (const Spec& spec, double sampleRate, int maxBlock);
    ~LivePluginStage();

    // Initialise the chain clock (reverbs.md decision 4's pattern):
    // zero at load, the warmup start at a locate.
    void startAt (juce::int64 clockSample);

    // Zero the processing state for a chain rebuild: a far locate
    // reuses the instance rather than reinstantiating — under liveLock
    // a rebuild's cost is dropped audio, not latency (minjudd's P2 on
    // #150). Identity, blob, and params are load-time facts a locate
    // never moves, and the far-seek warmup bound carries the same
    // state claim it always made for hosted arms.
    void reset();

    // In place; may emit fewer samples than fed while the latency
    // window primes.
    void process (std::vector<std::vector<float>>& working);

    // Feed the latency window of silence and append what emerges.
    void flush (std::vector<std::vector<float>>& tail);

    juce::int64 tailSamples() const; // declared growth, in samples
    juce::int64 latencySamples() const;

private:
    Spec spec;
    double rate;
    int maxBlock;
    // Declared before `instance` on purpose: members unwind in reverse,
    // so the plugin — which may consult its playhead during teardown —
    // is destroyed while the playhead still exists, on every path
    // including a constructor throw (#150 review).
    TrackPlayHead playHead;
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi;
    // Reused across process() calls: the master chain runs in the
    // device callback, which must not churn the heap per block.
    std::vector<std::vector<float>> emitScratch;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    juce::int64 clockPos = 0;
    juce::int64 toPrime = 0;
};

// --scan-probe <format> <fileOrIdentifier> <outFile>: describe every
// plugin type in one candidate, instantiating each to read its
// parameter table, one JSON object per line into <outFile>. A file, not
// stdout, because instantiating real plugins runs their code and real
// plugins chatter freely on stdout — the parent ignores the child's
// streams entirely and trusts only the file. Runs in its own process so
// a crash is a skip, recorded by the parent.
int runScanProbe (const std::string& formatName,
                  const std::string& candidate,
                  const std::string& outPath);

// --scan <format>: enumerate candidates in the format's default
// locations plus FIELD_PLUGIN_PATH, spawn ourselves with --scan-probe
// per candidate, and aggregate the surviving lines to stdout. Candidates
// whose probe dies are reported as {"failed": <candidate>} lines rather
// than dropped silently.
int runScan (const std::string& formatName, const std::string& exePath);

// --state-capture <format> <identifier> <paramsJson> <out>: instantiate,
// apply params through the same natural-value path the render uses, and
// write getStateInformation's bytes to <out>. Blobs are captured, never
// hand-written — a hosted instance's state stream has a format of its
// own (VST3 preset framing), which is the whole reason the chunk is
// opaque. The editor era's recapture (chunk 3) is this same verb driven
// by session signals.
int runStateCapture (const std::string& formatName,
                     const std::string& identifier,
                     const std::string& paramsJson,
                     const std::string& outPath);

// The render arm: instantiate, restore state, overlay params
// (decision 5), process with the track-local playhead (decision 13),
// trim declared latency, and ring out the tail (decision 11). Replaces
// `channels` with the processed buffers, which may be longer.
void applyPluginInsert (const juce::var& insert,
                        std::vector<std::vector<float>>& channels,
                        double sampleRate);

// True once hosting has initialised the JUCE runtime in this process.
// When it has, C++ static teardown at exit is unsafe: the runtime's
// DeletedAtShutdown list can hold entries whose memory belongs to a
// plugin module that already unloaded (measured — deleteAll() died in
// free() after a successful render). Subprocess modes consult this and
// leave via exitSubprocess instead of running finalizers.
bool hostingWasUsed();

// Flush and _Exit: the subprocess's artifact is already on disk or on
// stdout, and teardown has nothing left to contribute but the crash
// above.
[[noreturn]] void exitSubprocess (int code);
} // namespace field
