#pragma once

#include <juce_core/juce_core.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/limiter.h"
#include "dsp/plate.h"
#include "dsp/resample.h"
#include "dsp/reverb.h"

// The live session engine (realtime.md §3, chunk 2): evaluates the
// compiled graph the CLI sends — tracks, windows, chains — sample-exactly
// against the offline render, which is the golden-equivalence claim
// --render-live exists to prove.
//
// Evaluation is just-in-time offline rendering rather than a causal
// stream: every source is a committed or built file, so the future
// always exists, and a track's chain (whose limiter wants lookahead) is
// satisfied by producing children slightly ahead of the playback clock.
// Rings are therefore timeline-aligned full buffers — track lengths are
// compiler-computed and finite — and the compiler's comp_delay fields
// stay zero in practice until recording introduces a source whose future
// does not exist yet. Memory over machinery, deliberately: creek is
// ~7 MB of track buffers, the freeze chunk replaces most of them with
// cached stem files, and a streaming ring is an optimization this
// design leaves room for rather than a correctness requirement.
//
// The window arithmetic is mixdown.cpp's sumClips per sample, in clip
// order — same accumulation, same float roundings, same fades and
// balance law — and the loop fold on the output track replicates
// applyDeclaredLength's addition order, computed on read. Chains are the
// chunk-1 streaming classes, so block partitioning cannot move a bit.

namespace field
{

class LiveSession
{
public:
    // Parses fail-closed (plan.cpp's discipline): any missing field,
    // unknown effect, unknown track ref, or negative live delay throws,
    // and nothing renders under a shape the two sides disagree about.
    LiveSession (const juce::var& session, const juce::File& projectRoot);

    int sessionRate() const { return rate; }
    juce::int64 lengthSamples() const { return length; } // 0 = unbounded
    bool looping() const { return loop; }

    // Fill `n` frames of the output track at the session clock, advancing
    // it; wraps at the declared length when looping (the fold included).
    // Channel counts beyond stereo are zero-filled.
    void renderBlock (float* const* out, int numChannels, int n);

    void locate (juce::int64 sample);
    // What has been delivered to the device — the honest transport
    // position; the input clock runs ahead of it by any limiter window.
    juce::int64 position() const { return delivered; }

    // A window gain glide (session.ts rampRequestSchema): dB-linear over
    // rampMs, applied to contributions produced after the call. Throws on
    // an unknown track or input index.
    void ramp (const std::string& track, int input, double gainDb, double rampMs);

private:
    struct ChainStage
    {
        // Exactly one is set; a tiny variant without the ceremony.
        std::unique_ptr<dsp::Eq> eq;
        std::unique_ptr<dsp::Limiter> limiter;
        std::unique_ptr<dsp::Reverb> reverb;
        std::unique_ptr<dsp::Plate> plate;
    };
    // Everything needed to rebuild a stage: locate discards chain state
    // (a seek does not inherit the previous position's tails) and
    // reconstructs from these.
    struct ChainSpec
    {
        int kind = 0; // 0 eq, 1 limit, 2 reverb, 3 plate
        std::vector<dsp::Band> bands;
        bool normalize = false;
        dsp::LimiterSettings limiter;
        double horizonDb = 0.0;
        dsp::ReverbSettings reverb;
        dsp::PlateSettings plate;
    };

    struct Window
    {
        enum Kind { file, track, receivePre } kind = file;
        int source = 0; // files[] or tracks[] index by kind
        juce::int64 start = 0;
        juce::int64 duration = 0;
        juce::int64 readOffset = 0;
        double gainDb = 0.0;
        double pan = 0.0;
        juce::int64 fadeIn = 0;
        juce::int64 fadeOut = 0;
        juce::int64 compDelay = 0;
        // Ramp state: gain glides from rampFromDb to gainDb across
        // [rampStart, rampStart + rampLength) on this track's input
        // timeline; produceUntil evaluates it per sample.
        double rampFromDb = 0.0;
        juce::int64 rampStart = -1;
        juce::int64 rampLength = 0;
    };

    struct Track
    {
        std::string name;
        int rate = 0;
        std::vector<Window> windows;
        std::vector<ChainStage> chain;
        std::vector<ChainSpec> chainSpecs;
        juce::int64 preLength = 0; // content end (before the chain grows it)
        juce::int64 postLength = 0;
        bool needPre = false; // some cable taps pre
        // Timeline-aligned buffers; produced counts post-chain samples
        // emitted so far (the limiter's stream lag makes produced trail
        // fed), fed counts input samples pushed through the chain.
        std::vector<std::vector<float>> post; // [2][postLength]
        std::vector<std::vector<float>> pre; // [2][preLength], when needed
        // Materialized edge conversions (cross-rate-live.md decision 1):
        // this track's buffer converted wholesale to a consumer's rate
        // through the offline wrapper — the same kernel on the same
        // samples the offline convert node runs, so bit-identity with
        // the offline render is by construction. Keyed by consumer
        // rate; built off the audio thread at load.
        std::map<int, std::vector<std::vector<float>>> postConverted;
        std::map<int, std::vector<std::vector<float>>> preConverted;
        juce::int64 produced = 0;
        juce::int64 fed = 0;
    };

    void produceUntil (int trackIndex, juce::int64 outputSamples);
    // Produce the child in full and convert its buffer to targetRate,
    // once per (track, rate). Runs on the message thread — during the
    // load's pre-render recursion or the constructor's eager pass — so
    // the callback only ever finds the map populated.
    void ensureConverted (int trackIndex, int targetRate, bool pre);
    // startClock is where the rebuilt chain starts rendering on the
    // unwrapped timeline: zero at load, the warmup start at a locate —
    // the plate's LFO phase is a pure function of it (reverbs.md
    // decision 4).
    void buildChain (Track& track, juce::int64 startClock = 0) const;
    // The history the output chain must hear for its state at a
    // position to be right within the design's audibility threshold —
    // what locate renders and discards after a rebuild.
    juce::int64 chainWarmup (const Track& track) const;
    // Render forward to `sample`, discarding the audio: the chain hears
    // exactly what it would have, so its state afterwards is not an
    // approximation.
    void discardUntil (juce::int64 sample);
    // `absoluteFrom` is the unwrapped timeline position of `from` — the
    // output track mixes in wrapped time but ramps glide on real time,
    // so a fader move never reverses after a loop wrap.
    void mixInputBlock (Track& track,
                        juce::int64 from,
                        int n,
                        std::vector<std::vector<float>>& block,
                        juce::int64 absoluteFrom);
    // Runs `working` through the chain from `fromStage`; a limiter stage
    // re-points working at what it emitted (which may be shorter while
    // its window primes).
    static void runChain (Track& track, std::vector<std::vector<float>>& working, size_t fromStage);
    // End of input: flush each limiter and cascade what emerges through
    // the stages after it, appending to `working`.
    static void flushChain (Track& track, std::vector<std::vector<float>>& working);

    int rate = 0;
    juce::int64 length = 0;
    bool loop = false;
    int outputTrack = 0;
    juce::int64 clock = 0; // input timeline consumed
    juce::int64 delivered = 0; // output delivered (lags clock by chain latency)

    // Callback scratch, allocated at load so the audio thread never
    // touches the heap in steady state (children pre-render at load for
    // the same reason).
    std::vector<std::vector<float>> scratchBlock;
    std::vector<std::vector<float>> scratchMixed;

    std::vector<std::vector<std::vector<float>>> files; // preloaded, 1–2 ch
    std::vector<Track> tracks;
    std::map<std::string, int> trackIndex;
};

// --render-live: run a session offline, faster than realtime, into a
// float32 WAV — the graph-level golden instrument realtime.md decision 3
// requires. Not a render strategy (decision 1 keeps the build on stems);
// it exists so a live evaluation can be byte-compared against the
// offline artifact for the same graph. Empty string on success.
std::string runRenderLive (const std::string& sessionPath,
                           const std::string& outputPath,
                           const std::string& rootPath);

} // namespace field
