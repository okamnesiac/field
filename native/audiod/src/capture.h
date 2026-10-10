#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

// One recording transaction (recording.md §5; audio-engine.md "Crash-safe
// recording"): `.field/recording/<id>/` holds a manifest, a journal, and
// the audio, written continuously so a crash loses nothing the writer
// had reached the disk with.
//
// The audio is one append-only WAV, `take.wav`, whose header sizes are
// patched at finalize. Until then the file is exactly the transaction
// the plan describes — data on disk, header saying zero frames — and
// that unpatched header is what marks it incomplete: recover() patches
// it from the file size, and a finalized take differs from a recovered
// one only in the manifest saying which happened. A separate chunk file
// per flush was the other reading of "recoverable chunks"; it buys
// nothing here, because a process crash keeps everything fwrite reached
// the kernel with, and the journal records what fsync reached the disk
// with for the power-loss case.
//
// Threading: push() is the audio thread's only entry — a copy into a
// lock-free FIFO, no allocation, no I/O, counting what did not fit
// instead of blocking. A writer thread drains the FIFO every 20 ms,
// appends to the file, and once a second syncs and rewrites the
// journal. finalize() runs on the message thread after the callback has
// stopped pushing (the Player's epoch wait guarantees that), joins the
// writer, drains the remainder, patches the header, and writes the
// final manifest.

namespace field
{

class Capture
{
public:
    struct Facts
    {
        juce::String track; // the record target, as the CLI named it
        juce::String song; // the live session's song, when one is loaded
        juce::String source; // the loaded file, when file playback is the bed
        juce::String device; // the input device
        int input = 0; // 1-based channel on that device, as a person counts
        double sampleRate = 0.0; // the device's: the rate the bytes are at
        double timelineRate = 0.0; // the bed's: the rate started_at_samples counts in (0 = no bed)
        // As the device reports them (recording.md §3): recorded here as
        // facts; which of them placement subtracts is chunk 2's loopback
        // measurement, not this code's guess.
        int inputLatency = 0;
        int outputLatency = 0;
        juce::String daemonVersion;
    };

    // Creates the transaction directory under root/.field/recording/,
    // writes the header and the manifest, starts the writer. Throws
    // std::runtime_error when the directory or file cannot be made.
    Capture (const juce::File& root, const Facts& facts);
    // A capture still open here is left as a recoverable transaction —
    // the writer is joined and what it drained is on disk, header
    // unpatched — which is what a daemon dying mid-take looks like too.
    ~Capture();

    const juce::String& id() const { return transactionId; }
    juce::File directory() const { return dir; }

    // Audio thread. The callback latches the transport position of the
    // first captured block and tells the capture once, before pushing.
    void setStartedAt (juce::int64 positionSamples) noexcept;
    void push (const float* samples, int n) noexcept;

    juce::int64 pushed() const { return pushedFrames.load(); }
    juce::int64 dropped() const { return droppedFrames.load(); }
    juce::int64 written() const { return writtenFrames.load(); }
    juce::int64 startedAt() const { return startedAtSamples.load(); }

    // Message thread, after the callback has stopped pushing. Returns the
    // final manifest (what `recordings` lists and the `take` event
    // carries). Idempotent: a second call returns the same manifest.
    juce::var finalize();
    // Message thread: a transaction that never received a sample — a
    // loop take's standby the loop ended before reaching — is not a
    // take; its directory goes away. Only valid before finalize.
    void discard();

    // What lives under root/.field/recording/: one entry per
    // transaction, complete or not, with the frames on disk and whether
    // it is the one still being written.
    static juce::var list (const juce::File& root, const juce::String& activeId);
    // Patch an incomplete transaction's header from its file size and
    // mark the manifest recovered. Throws on an unknown id, an already
    // complete take, or an unreadable file. Never call on the active
    // transaction — the Player refuses that before getting here.
    static juce::var recover (const juce::File& root, const juce::String& id);

private:
    void writerLoop();
    void drain();
    void writeManifest (bool complete, bool recovered);
    void writeJournal();

    juce::File dir;
    juce::String transactionId;
    juce::String startedWall; // when the transaction opened, fixed at construction
    Facts facts;
    std::FILE* wav = nullptr;

    juce::AbstractFifo fifo;
    std::vector<float> ring;
    std::vector<float> scratch; // writer-side staging for the file write

    std::atomic<juce::int64> startedAtSamples { -1 };
    std::atomic<juce::int64> pushedFrames { 0 };
    std::atomic<juce::int64> droppedFrames { 0 };
    std::atomic<juce::int64> writtenFrames { 0 };
    juce::int64 journaledFrames = 0;
    bool manifestHasStart = false;

    std::thread writer;
    std::atomic<bool> stopWriter { false };
    juce::WaitableEvent wake;
    bool finalized = false;
    juce::var finalManifest;
};

} // namespace field
