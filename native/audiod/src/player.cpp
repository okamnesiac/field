#include "player.h"

namespace
{
juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

constexpr int nullBlockSize = 512;
constexpr double nullSampleRate = 48000.0;
} // namespace

Player::Player (bool useNullOutput) : nullMode (useNullOutput)
{
    formatManager.registerBasicFormats();
}

Player::~Player()
{
    if (nullClockRunning.exchange (false) && nullClock.joinable())
        nullClock.join();
    if (! nullMode)
        deviceManager.removeAudioCallback (this);
    transport.setSource (nullptr);
}

juce::String Player::initialise()
{
    readThread.startThread();

    if (nullMode)
    {
        transport.prepareToPlay (nullBlockSize, nullSampleRate);
        nullClockRunning = true;
        nullClock = std::thread ([this]
        {
            juce::AudioBuffer<float> scratch (2, nullBlockSize);
            while (nullClockRunning)
            {
                juce::AudioSourceChannelInfo info (&scratch, 0, nullBlockSize);
                transport.getNextAudioBlock (info);
                // Real-time pace, so position and end-of-stream behave as
                // they would against a device.
                std::this_thread::sleep_for (std::chrono::microseconds (
                    (long long) (1'000'000.0 * nullBlockSize / nullSampleRate)));
            }
        });
        return {};
    }

    auto error = deviceManager.initialiseWithDefaultDevices (0, 2);
    if (error.isNotEmpty())
        return error;
    deviceManager.addAudioCallback (this);
    return {};
}

juce::var Player::deviceList()
{
    auto result = obj();
    juce::Array<juce::var> devices;
    if (! nullMode)
    {
        if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        {
            type->scanForDevices();
            auto names = type->getDeviceNames (false);
            auto defaultIndex = type->getDefaultDeviceIndex (false);
            for (int i = 0; i < names.size(); ++i)
            {
                auto d = obj();
                d->setProperty ("name", names[i]);
                d->setProperty ("default", i == defaultIndex);
                devices.add (juce::var (d.get()));
            }
        }
    }
    result->setProperty ("devices", devices);
    result->setProperty ("null_output", nullMode);
    return juce::var (result.get());
}

juce::String Player::selectDevice (const juce::String& name)
{
    if (nullMode)
        return "no devices in null-output mode";
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = name;
    return deviceManager.setAudioDeviceSetup (setup, true);
}

void Player::maybeMatchDeviceRate (double fileRate)
{
    // Decision (playback.md §3.5): prefer running the device at the file's
    // rate; if the device refuses, the transport resamples and status says
    // so. Best-effort by design — failure here is not an error.
    if (nullMode)
        return;
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr || juce::exactlyEqual (device->getCurrentSampleRate(), fileRate))
        return;
    if (! device->getAvailableSampleRates().contains (fileRate))
        return;
    auto setup = deviceManager.getAudioDeviceSetup();
    setup.sampleRate = fileRate;
    deviceManager.setAudioDeviceSetup (setup, false);
}

juce::var Player::load (const juce::File& file)
{
    auto result = obj();
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
    if (reader == nullptr)
    {
        result->setProperty ("error", "cannot read audio file: " + file.getFullPathName());
        return juce::var (result.get());
    }

    transport.stop();
    transport.setSource (nullptr);
    readerSource.reset();

    fileSampleRate = reader->sampleRate;
    fileLengthSamples = reader->lengthInSamples;
    fileChannels = (int) reader->numChannels;
    loadedPath = file.getFullPathName();
    everStarted = false;

    maybeMatchDeviceRate (fileSampleRate);

    readerSource = std::make_unique<juce::AudioFormatReaderSource> (reader.release(), true);
    // Handing the transport the file's rate is what makes it resample when
    // the device runs at a different one.
    transport.setSource (readerSource.get(), 1 << 15, &readThread, fileSampleRate);
    transport.setPosition (0.0);

    result->setProperty ("samples", fileLengthSamples);
    result->setProperty ("sample_rate", fileSampleRate);
    result->setProperty ("channels", fileChannels);
    return juce::var (result.get());
}

juce::String Player::play()
{
    if (readerSource == nullptr)
        return "nothing loaded";
    if (streamFinished())
        transport.setPosition (0.0); // play after natural end restarts
    everStarted = true;
    transport.start();
    return {};
}

void Player::pause()
{
    transport.stop();
}

void Player::stop()
{
    transport.stop();
    transport.setPosition (0.0);
    everStarted = false;
}

juce::String Player::locate (juce::int64 sample)
{
    if (readerSource == nullptr)
        return "nothing loaded";
    if (sample < 0 || sample > fileLengthSamples)
        return "locate out of range";
    transport.setPosition ((double) sample / fileSampleRate);
    return {};
}

juce::int64 Player::positionSamples() const
{
    if (fileSampleRate <= 0.0)
        return 0;
    return (juce::int64) std::llround (transport.getCurrentPosition() * fileSampleRate);
}

bool Player::streamFinished() const
{
    return readerSource != nullptr && everStarted && transport.hasStreamFinished();
}

juce::String Player::transportState()
{
    if (transport.isPlaying())
        return "playing";
    if (readerSource != nullptr && everStarted && positionSamples() > 0 && ! streamFinished())
        return "paused";
    return "stopped";
}

juce::var Player::status()
{
    auto result = obj();
    result->setProperty ("state", transportState());
    result->setProperty ("sample", positionSamples());
    result->setProperty ("samples", fileLengthSamples);
    result->setProperty ("path", loadedPath.isEmpty() ? juce::var() : juce::var (loadedPath));
    result->setProperty ("null_output", nullMode);

    double deviceRate = nullMode ? nullSampleRate : 0.0;
    if (! nullMode)
        if (auto* device = deviceManager.getCurrentAudioDevice())
        {
            deviceRate = device->getCurrentSampleRate();
            auto d = obj();
            d->setProperty ("name", device->getName());
            d->setProperty ("sample_rate", deviceRate);
            result->setProperty ("device", juce::var (d.get()));
        }
    result->setProperty ("resampling",
                         readerSource != nullptr && deviceRate > 0.0
                             && ! juce::exactlyEqual (deviceRate, fileSampleRate));
    return juce::var (result.get());
}

void Player::audioDeviceIOCallbackWithContext (const float* const*, int,
                                               float* const* outputChannelData,
                                               int numOutputChannels,
                                               int numSamples,
                                               const juce::AudioIODeviceCallbackContext&)
{
    juce::AudioBuffer<float> buffer (outputChannelData, numOutputChannels, numSamples);
    juce::AudioSourceChannelInfo info (&buffer, 0, numSamples);
    transport.getNextAudioBlock (info);
}

void Player::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    transport.prepareToPlay (device->getCurrentBufferSizeSamples(), device->getCurrentSampleRate());
}

void Player::audioDeviceStopped()
{
    transport.releaseResources();
}
