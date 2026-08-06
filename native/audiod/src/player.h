#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <atomic>
#include <memory>
#include <thread>

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
class Player : private juce::AudioIODeviceCallback,
               private juce::Timer
{
public:
    explicit Player (bool useNullOutput);
    ~Player() override;

    // Empty string on success, otherwise the error.
    juce::String initialise();

    juce::var deviceList();
    juce::String selectDevice (const juce::String& name);

    // Re-reads Core Audio's world after a hot-plug or default-output
    // change (message thread; marshalled from the Core Audio listener).
    // The daemon follows the system default live unless the user
    // explicitly selected a device; a selection whose device vanishes
    // resets to the default. This is what keeps a long-lived daemon's
    // output honest against the `*` in `bloom devices` (#16).
    void refreshAudioDevice();

    // Returns {error} or {samples, sample_rate, channels}. With loop the
    // reader wraps at end-of-file — gapless, sample-exact — and the
    // stream never finishes: stop is the only way out, which is exactly
    // the blocking-play contract `bloom play --loop` wants.
    juce::var load (const juce::File& file, bool loop);

    // Queues a takeover of the looping stream (watch.md §1.1): the new
    // file is opened and prepared now; the swap lands at the next wrap,
    // detected by a fine poll of the transport position, so it sits
    // within one poll tick of the wrap — a seam-sized blink at the loop
    // point. (watch.md §1.1's recorded successor, a sample-exact
    // double-buffered bar-synced swap, replaces this poll when wrap
    // latency chafes.) Returns {error} or the new file's {samples,
    // sample_rate, channels}. Requires a loaded looping stream; a paused
    // or stopped transport swaps immediately without starting.
    juce::var reload (const juce::File& file);

    // The path applied by the last completed reload takeover, cleared on
    // read; the heartbeat turns it into a broadcast "reloaded" event.
    juce::String takeReloadedPath();

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

    // The reload poll (message thread, running only while a reload is
    // pending): a position moving backwards is the reader wrapping.
    void timerCallback() override;
    void applyReload();

    void registerHardwareListeners();
    void removeHardwareListeners();

    const bool nullMode;
    // True once device.select succeeds; cleared if that device vanishes.
    bool explicitSelection = false;
    bool hardwareListenersRegistered = false;
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

    // A queued takeover: the reader is opened at reload() time so the
    // wrap-side work is just a source swap. All touched on the message
    // thread only.
    struct PendingReload
    {
        std::unique_ptr<juce::AudioFormatReaderSource> source;
        juce::String path;
        double sampleRate = 0.0;
        juce::int64 length = 0;
        int channels = 0;
    };
    std::unique_ptr<PendingReload> pendingReload;
    juce::int64 reloadPollPosition = 0;
    juce::String reloadedPath;

    // Null-output mode: a thread pulls the transport at real-time pace so
    // transport, position, and end-of-stream all behave exactly as with a
    // device — CI runs the full protocol with no audio hardware.
    std::thread nullClock;
    std::atomic<bool> nullClockRunning { false };
};
