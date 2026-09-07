#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <functional>
#include <memory>
#include <thread>
#include <vector>

#include "dsp/resample.h"

namespace field
{
class Capture;
class LiveSession;
}

// Owns the output device (or the null-output clock used in CI), the loaded
// file, the sample-accurate transport, and — once something arms — the
// input side of the same device (recording.md §5). Artifacts-only by
// design (playback.md §1): the player knows file paths and samples —
// never clips, tracks, or tempo maps. The record target it is handed is
// a name it writes into the take's manifest and nothing more.
//
// Threading contract: every public method is called with the JUCE message
// manager locked (server.cpp and main.cpp both hold it), so this class
// adds no locking of its own beyond the transport's internal locks. The
// audio callback and the null clock only touch the transport, which is
// safe by JUCE's design.
class Player : private juce::AudioIODeviceCallback
{
public:
    explicit Player (bool useNullOutput);
    ~Player() override;

    // Empty string on success, otherwise the error.
    juce::String initialise();

    juce::var deviceList();
    juce::String selectDevice (const juce::String& name);

    // Whether the platform will *tell* us the hardware moved. Only Core
    // Audio does (the property listeners in player.cpp, #16); everywhere
    // else the heartbeat has to look, so main.cpp reads this instead of
    // branching on the preprocessor itself
    // (linux-portability.md decision 2).
    static constexpr bool hardwareListenersAvailable =
#if JUCE_MAC
        true;
#else
        false;
#endif

    // Re-reads the audio world after a hot-plug or default-output change
    // (message thread; marshalled from the Core Audio listener on macOS,
    // polled from the heartbeat elsewhere). The daemon follows the system
    // default live unless the user explicitly selected a device; a
    // selection whose device vanishes resets to the default. This is what
    // keeps a long-lived daemon's output honest against the `*` in
    // `field devices` (#16).
    void refreshAudioDevice();

    // Returns {error} or {samples, sample_rate, channels}. With loop the
    // reader wraps at end-of-file — gapless, sample-exact — and the
    // stream never finishes: stop is the only way out, which is exactly
    // the blocking-play contract `field play --loop` wants.
    juce::var load (const juce::File& file, bool loop);


    // Live session (realtime.md chunk 2): replaces the loaded file as the
    // audio source; the transport verbs drive the session clock instead.
    // Returns {error} or {samples, sample_rate, channels}. Loading a file
    // afterwards drops the session, and vice versa. Enter WITHOUT the
    // MessageManagerLock: construction instantiates plugins, which
    // marshal to the message thread — a caller holding the lock would
    // wait on itself (minjudd's P1 on #150). The install takes the lock
    // internally, so player state stays message-thread-owned; the
    // replaced session dies on the message thread later, because AU
    // teardown under any held lock is the same deadlock again
    // (retireOnMessageThread in player.cpp).
    juce::var loadSession (const juce::var& session, const juce::File& projectRoot);
    juce::String liveRamp (const juce::String& track, int input, double gainDb, double rampMs);
    bool liveMode() const { return liveSession != nullptr; }

    juce::String play();
    void pause();
    void stop(); // pause + rewind to 0
    juce::String locate (juce::int64 sample);

    // consumePeak: the status op passes true, so a client reading the
    // meter gets the peak since the last client read and resets it. The
    // heartbeat reads status four times a second for its own events and
    // must not consume the meter — it did at first, and every client
    // then saw at most a quarter-second window, which on a busy CI runner
    // read a sawtooth that spans ±1 as 0.48.
    juce::var status (bool consumePeak = false);

    // "playing" | "paused" | "stopped"; drives state-change events (main.cpp).
    juce::String transportState();

    // True once the loaded file has played to its end; main.cpp turns this
    // into a stop plus a broadcast state event.
    bool streamFinished() const;

    bool nullOutput() const { return nullMode; }

    // Recording (recording.md §5–6). arm opens the input side — the
    // duplex open happens here, not at spawn, so a playback-only session
    // never triggers the microphone prompt — and names the track and the
    // 1-based input channel the take will record. Returns {error} or the
    // device facts: {device, input, channels, sample_rate, input_latency,
    // output_latency}. Re-arming while armed moves the input; arming
    // while recording is refused.
    juce::var arm (const juce::String& track, const juce::String& device, int input);
    // Closes the input side again. Empty string on success.
    juce::String disarm();
    // Start a take: locate to `at` when given (a source must be loaded
    // for that), start the transport if it is not running, and capture
    // from the next block. The callback latches the transport position
    // of that block as started_at_samples; the response waits for the
    // latch so it can report it. Returns {error} or {transaction,
    // started_at_samples}.
    juce::var record (const juce::var& at);
    // Finalize the take in progress: the callback stops pushing, the
    // writer drains, the header is patched, the manifest is final.
    // Returns the manifest, or void when nothing was recording. stop()
    // and pause() call this first; a natural end of stream reaches it
    // through stop() too.
    juce::var stopRecording();
    // "idle" | "armed" | "recording" — drives record events (main.cpp).
    juce::String recordState() const;
    // An armed or recording daemon must not idle-exit (recording.md §5):
    // a take would die to a timeout.
    bool recordingPinned() const { return armed.load() || capture != nullptr; }
    // The transactions under .field/recording/, and recovery of one a
    // dead daemon left behind (capture.h).
    juce::var recordings() const;
    juce::var recover (const juce::String& id) const;
    // Set by main.cpp: a finalized take's manifest, however the take
    // ended (a stop op, a remote stop, end of stream), so every client
    // hears about it.
    std::function<void (const juce::var&)> onTake;

private:
    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

    juce::int64 positionSamples() const;
    void maybeMatchDeviceRate (double fileRate);

    // The one block both the device callback and the null clock go
    // through: the output pull, then the capture tap over the input.
    // Input first would read as natural, but the order is immaterial —
    // both halves describe the same block — and pulling first is what
    // yields the transport position the tap latches.
    void processBlock (const float* const* in, int numInputs, float* const* out, int numOutputs, int n);
    // The output pull: the live session when one is loaded (behind a
    // try-lock — a missed block during a message-thread edit is silence,
    // not a glitch), the file transport otherwise. Returns the transport
    // position at the start of the block, or -1 when the lock was missed
    // and the block is silence — a capture start defers to the next
    // block then, which keeps the latch and the first pushed samples
    // describing the same instant.
    juce::int64 pullAudio (float* const* out, int numChannels, int n);


    void registerHardwareListeners();
    void removeHardwareListeners();

    const bool nullMode;
    // True once device.select succeeds; cleared if that device vanishes.
    bool explicitSelection = false;
#if JUCE_MAC
    bool hardwareListenersRegistered = false;
#endif
    juce::AudioDeviceManager deviceManager;
    juce::AudioFormatManager formatManager;
    juce::TimeSliceThread readThread { "audiod file reader" };
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    juce::AudioTransportSource transport;

    juce::String loadedPath;
    double fileSampleRate = 0.0;
    juce::int64 fileLengthSamples = 0;
    int fileChannels = 0;
    bool everStarted = false; // distinguishes "stopped at 0" from "never played"
    bool looping = false;


    // The live session and its transport-facing facts. livePlaying is
    // read in the audio callback; the lock covers session access.
    std::unique_ptr<field::LiveSession> liveSession;
    juce::CriticalSection liveLock;
    std::atomic<bool> livePlaying { false };
    juce::int64 liveLength = 0;
    juce::String liveSong;
    bool liveLoop = false;
    int liveRate = 0;
    bool liveEverStarted = false;

    // Delivery conversion (cross-rate-live.md decision 3): when the
    // device cannot switch to the session's rate, the output stream
    // runs through the streaming resampler instead of refusing.
    // Rebuilt — which is also the reset the plan specifies — under
    // liveLock at locate, stop, and device start; null when the rates
    // agree. A session swap keeps the converter and its FIFO when the
    // (session, device) rate pair is unchanged — the queued audio is
    // exactly what the ear should hear next, and dropping it skipped
    // 10–20 ms on every live-watch edit (minjudd's finding on #143) —
    // so loadSession installs prepared state instead of calling this.
    // convOut is the converted FIFO the callback drains; convQueued
    // mirrors its unread frame count for status (the in-flight skew
    // decision 3 bounds); completion is checked under liveLock in
    // streamFinished, where the mirror would race the final callback.
    void rebuildLiveConverter();
    double currentDeviceRate() const;
    std::unique_ptr<field::dsp::Resampler> liveConverter;
    std::vector<std::vector<float>> convIn;
    std::vector<std::vector<float>> convOut;
    size_t convOutRead = 0;
    bool convFlushed = false;
    std::atomic<juce::int64> convQueued { 0 };
    // The rate pair the conversion state was built for, so a swap can
    // tell a same-pair edit (keep everything) from a real change.
    double convLiveRate = 0.0;
    double convDeviceRate = 0.0;

    // Null-output mode: a thread pulls the transport at real-time pace so
    // transport, position, and end-of-stream all behave exactly as with a
    // device — CI runs the full protocol with no audio hardware. Armed,
    // the same thread presents an input: two channels, a sawtooth
    // encoding the input clock on the first and a constant on the second
    // (nullInputBlock), so a test can prove a take is gapless and that
    // channel selection picked the channel it named.
    std::thread nullClock;
    std::atomic<bool> nullClockRunning { false };

    // Recording state. The message thread owns armed*, capture and the
    // Facts; the callback reads activeCapture, captureChannel and the
    // start request. activeCapture is cleared before finalize, and
    // finalize waits for callbackEpoch to advance twice — the block in
    // flight and one more — so no push can be running when the Capture
    // dies (the same discipline as the live session's try-lock, in the
    // other direction).
    std::atomic<bool> armed { false }; // read by the null clock to present its input
    juce::String armedTrack;
    juce::String armedDevice;
    int armedInput = 0;
    std::unique_ptr<field::Capture> capture;
    std::atomic<field::Capture*> activeCapture { nullptr };
    // Which of the callback's input channels to capture. A real device
    // is opened with exactly one input channel active, and the callback
    // array holds only active channels, so this is 0 there; the null
    // clock presents the selected null channel the same way.
    std::atomic<int> captureChannel { 0 };
    // Null mode only: which of the null input's two channels the clock
    // presents as the one active channel (1-based, as arm names it).
    std::atomic<int> nullInputChannel { 1 };
    std::atomic<bool> captureStartRequested { false };
    std::atomic<bool> captureStarted { false };
    std::atomic<juce::uint64> callbackEpoch { 0 };
    // Largest |sample| on the armed input since status last read it; the
    // V1 meter (recording.md §11's meters question, resolved in §12).
    std::atomic<float> inputPeak { 0.0f };
    // The capture position when nothing is loaded: a free clock from
    // arm, so a take with no bed still has a definite, if arbitrary,
    // placement.
    std::atomic<juce::int64> freeClock { 0 };
    // Zeros the tap pushes when a take is running and the callback
    // arrived with no input channel (the device restarted without one):
    // the take stays gapless and its placement stays right. Sized for
    // the device's block on start.
    std::vector<float> silence;
};
