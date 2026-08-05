#pragma once

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
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
class Player : private juce::AudioIODeviceCallback
{
public:
    explicit Player (bool useNullOutput);
    ~Player() override;

    // Empty string on success, otherwise the error.
    juce::String initialise();

    juce::var deviceList();
    juce::String selectDevice (const juce::String& name);

    // Returns {error} or {samples, sample_rate, channels}.
    juce::var load (const juce::File& file);

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

    const bool nullMode;
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

    // Null-output mode: a thread pulls the transport at real-time pace so
    // transport, position, and end-of-stream all behave exactly as with a
    // device — CI runs the full protocol with no audio hardware.
    std::thread nullClock;
    std::atomic<bool> nullClockRunning { false };
};
