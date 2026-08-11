#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <memory>
#include <thread>

namespace field
{
class LiveSession;
}

// Owns the output device (or the null-output clock used in CI), the loaded
// file, and the sample-accurate transport. Artifacts-only by design
// (playback.md §1): the player knows file paths and samples — never clips,
// tracks, or tempo maps.
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
    // afterwards drops the session, and vice versa.
    juce::var loadSession (const juce::var& session, const juce::File& projectRoot);
    juce::String liveRamp (const juce::String& track, int input, double gainDb, double rampMs);
    bool liveMode() const { return liveSession != nullptr; }

    juce::String play();
    void pause();
    void stop(); // pause + rewind to 0
    juce::String locate (juce::int64 sample);

    juce::var status();

    // "playing" | "paused" | "stopped"; drives state-change events (main.cpp).
    juce::String transportState();

    // True once the loaded file has played to its end; main.cpp turns this
    // into a stop plus a broadcast state event.
    bool streamFinished() const;

    bool nullOutput() const { return nullMode; }

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

    // The one audio pull both the device callback and the null clock go
    // through: the live session when one is loaded (behind a try-lock —
    // a missed block during a message-thread edit is silence, not a
    // glitch), the file transport otherwise.
    void pullAudio (float* const* out, int numChannels, int n);

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

    // Null-output mode: a thread pulls the transport at real-time pace so
    // transport, position, and end-of-stream all behave exactly as with a
    // device — CI runs the full protocol with no audio hardware.
    std::thread nullClock;
    std::atomic<bool> nullClockRunning { false };
};
