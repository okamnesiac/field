#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

// One recording transaction (recording.md §5; audio-engine.md "Crash-safe
// recording"): `.field/recording/<id>/` holds a manifest, a journal, and
// the take's data file, written continuously so a crash loses nothing the
// writer had reached the disk with.
//
// An audio take's data is one append-only WAV, `take.wav`, whose header
// sizes are patched at finalize. Until then the file is exactly the
// transaction the plan describes — data on disk, header saying zero
// frames — and that unpatched header is what marks it incomplete:
// recover() patches it from the file size, and a finalized take differs
// from a recovered one only in the manifest saying which happened. A
// separate chunk file per flush was the other reading of "recoverable
// chunks"; it buys nothing here, because a process crash keeps everything
// fwrite reached the kernel with, and the journal records what fsync
// reached the disk with for the power-loss case.
//
// A MIDI take's data (keyboard-instrument.md §12.4) is `take.midi.ndjson`,
// one `{"at":<samples from the start>,"midi":[...]}` line per message, so
// a crash loses at most a partial last line, which recover() drops.
//
// Threading: push() is the audio thread's only entry — a copy into a
// lock-free FIFO, no allocation, no I/O, counting what did not fit
// instead of blocking. A writer thread drains the FIFO every 20 ms,
// appends to the file, and once a second syncs and rewrites the
// journal. finalize() runs on the message thread after the callback has
// stopped pushing (the Player's epoch wait guarantees that), joins the
// writer, drains the remainder, closes the file, and writes the final
// manifest.

namespace field
{

// What the two kinds of take share: the directory and its timestamped
// id, the manifest and journal, the writer thread, finalize, and the
// list and recover that read any transaction back.
class Transaction
{
public:
    struct Facts
    {
        juce::String track; // the record target, as the CLI named it
        juce::String song; // the live session's song, when one is loaded
        juce::String source; // the loaded file, when file playback is the bed
        juce::String device; // audio: the input device
        int input = 0; // audio: 1-based channel on that device, as a person counts
        juce::StringArray sources; // MIDI: the inputs the take listened to
        double sampleRate = 0.0; // the device's: the rate the take counts in
        double timelineRate = 0.0; // the bed's: the rate started_at_samples counts in (0 = no bed)
        // As the device reports them (recording.md §3): recorded here as
        // facts; which of them placement subtracts is chunk 2's loopback
        // measurement, not this code's guess.
        int inputLatency = 0;
        int outputLatency = 0;
        juce::String daemonVersion;
    };

    virtual ~Transaction();

    const juce::String& id() const { return transactionId; }
    juce::File directory() const { return dir; }
    // Project-root relative, as the manifest's `file` says it.
    juce::String file() const { return ".field/recording/" + transactionId + "/" + dataName; }

    // Audio thread. The callback latches the transport position of the
    // first captured block and tells the capture once, before pushing.
    void setStartedAt (juce::int64 positionSamples) noexcept;
    juce::int64 startedAt() const { return startedAtSamples.load(); }
    // The bed's rate, which startedAt() and `until` count in (0 = no bed).
    double timelineRate() const { return facts.timelineRate; }

    // Message thread: the take's own fields in status.record.
    virtual void describeProgress (juce::DynamicObject& record) const = 0;

    // Message thread, after the callback has stopped pushing. Returns the
    // final manifest (what `recordings` lists and the `take` event
    // carries). Idempotent: a second call returns the same manifest.
    juce::var finalize();
    // Message thread: a transaction that never received a sample — a
    // loop take's standby the loop ended before reaching — is not a
    // take; its directory goes away. Only valid before finalize.
    void discard();

    // What lives under root/.field/recording/: one entry per
    // transaction, complete or not, with what is on disk and whether it
    // is the one still being written.
    static juce::var list (const juce::File& root, const juce::String& activeId);
    // Make an incomplete transaction whole from what is on disk and mark
    // the manifest recovered. Throws on an unknown id, an already
    // complete take, or an unreadable file. Never call on the active
    // transaction — the Player refuses that before getting here.
    static juce::var recover (const juce::File& root, const juce::String& id);

protected:
    // Creates the transaction directory under root/.field/recording/ and
    // opens `dataName` in it. Throws std::runtime_error when either
    // cannot be made. The derived constructor writes what its file
    // starts with, then calls begin().
    Transaction (const juce::File& root, const Facts& facts, const char* dataName);
    // Writes the first manifest and journal and starts the writer; the
    // writer calls the derived class, so it cannot start any earlier.
    void begin();
    // The derived destructor calls this first: the writer calls the
    // derived class, so it must stop before that part is destroyed.
    void joinWriter();

    // Writer thread, and finalize after the join: FIFO to file.
    virtual void drain() = 0;
    // Finalize, after the last drain: what the file needs before close.
    virtual void completeData() {}
    // The manifest's kind-specific facts, then its counts once complete.
    virtual void describeFacts (juce::DynamicObject& manifest) const = 0;
    virtual void describeCounts (juce::DynamicObject& manifest) const = 0;
    virtual void describeJournal (juce::DynamicObject& journal) const = 0;

    Facts facts;
    std::FILE* data = nullptr;

private:
    void writerLoop();
    void syncData();
    void closeData();
    void writeManifest (bool complete);
    void writeJournal();

    juce::File dir;
    juce::String transactionId;
    juce::String dataName;
    juce::String startedWall; // when the transaction opened, fixed at construction
    std::atomic<juce::int64> startedAtSamples { -1 };
    bool manifestHasStart = false;

    std::thread writer;
    std::atomic<bool> stopWriter { false };
    juce::WaitableEvent wake;
    bool finalized = false;
    juce::var finalManifest;
};

// An audio take: one mono float32 WAV at the device's rate.
class Capture final : public Transaction
{
public:
    Capture (const juce::File& root, const Facts& facts);
    // A capture still open here is left as a recoverable transaction —
    // the writer is joined and what it drained is on disk, header
    // unpatched — which is what a daemon dying mid-take looks like too.
    ~Capture() override;

    void push (const float* samples, int n) noexcept;

    juce::int64 pushed() const { return pushedFrames.load(); }
    juce::int64 dropped() const { return droppedFrames.load(); }
    juce::int64 written() const { return writtenFrames.load(); }

    void describeProgress (juce::DynamicObject& record) const override;

private:
    void drain() override;
    void completeData() override;
    void describeFacts (juce::DynamicObject& manifest) const override;
    void describeCounts (juce::DynamicObject& manifest) const override;
    void describeJournal (juce::DynamicObject& journal) const override;

    juce::AbstractFifo fifo;
    std::vector<float> ring;
    std::vector<float> scratch; // writer-side staging for the file write

    std::atomic<juce::int64> pushedFrames { 0 };
    std::atomic<juce::int64> droppedFrames { 0 };
    std::atomic<juce::int64> writtenFrames { 0 };
};

// A MIDI take (keyboard-instrument.md §12.4): the messages the callback
// stamped, each with its sample offset from the take's start at the
// device's rate, and the samples the take has run for.
class MidiCapture final : public Transaction
{
public:
    // A channel message is one to three bytes; a take records nothing
    // longer (Player::handleIncomingMidiMessage).
    static constexpr int maxMessageBytes = 3;

    MidiCapture (const juce::File& root, const Facts& facts);
    ~MidiCapture() override;

    // Audio thread: one stamped message, and the samples elapsed since
    // the start. Messages arrive in `at` order.
    void push (juce::int64 at, const juce::uint8* bytes, int size) noexcept;
    void setFrames (juce::int64 frames) noexcept { elapsedFrames.store (frames); }
    // Audio thread: messages lost before they reached this take (the
    // Player's arrival queue was full), so the manifest counts them.
    void addDropped (int messages) noexcept { droppedEvents.fetch_add (messages); }

    juce::int64 frames() const { return elapsedFrames.load(); }
    juce::int64 events() const { return pushedEvents.load(); }
    juce::int64 dropped() const { return droppedEvents.load(); }

    void describeProgress (juce::DynamicObject& record) const override;

private:
    struct Event
    {
        juce::int64 at = 0;
        int size = 0;
        juce::uint8 bytes[maxMessageBytes] {};
    };

    void drain() override;
    void describeFacts (juce::DynamicObject& manifest) const override;
    void describeCounts (juce::DynamicObject& manifest) const override;
    void describeJournal (juce::DynamicObject& journal) const override;

    juce::AbstractFifo fifo;
    std::vector<Event> ring;
    std::string lines; // writer-side staging for the file write

    std::atomic<juce::int64> elapsedFrames { 0 };
    std::atomic<juce::int64> pushedEvents { 0 };
    std::atomic<juce::int64> droppedEvents { 0 };
    std::atomic<juce::int64> writtenEvents { 0 };
};

} // namespace field
