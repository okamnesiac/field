#include "player.h"

#include "live.h"

#if JUCE_MAC
#include <CoreAudio/CoreAudio.h>
#endif

#include <utility>

#if JUCE_MAC
namespace
{
// Core Audio calls property listeners on its own thread; the handler
// marshals onto the message thread, where all Player state lives. The
// Player outlives the dispatch loop (main.cpp destroys it after the
// drain), so a lambda landing during shutdown still finds it alive, and
// listeners are removed in the destructor before that.
OSStatus hardwareChanged (AudioObjectID, UInt32, const AudioObjectPropertyAddress*, void* clientData)
{
    auto* player = static_cast<Player*> (clientData);
    juce::MessageManager::callAsync ([player] { player->refreshAudioDevice(); });
    return noErr;
}

constexpr AudioObjectPropertyAddress kDefaultOutputAddress {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
};
constexpr AudioObjectPropertyAddress kDeviceListAddress {
    kAudioHardwarePropertyDevices,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain,
};
} // namespace
#endif

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
    removeHardwareListeners();
    if (nullClockRunning.exchange (false) && nullClock.joinable())
        nullClock.join();
    if (! nullMode)
        deviceManager.removeAudioCallback (this);
    transport.setSource (nullptr);
}

// Core Audio is the only backend that will tell us. Everywhere else these
// are no-ops and the heartbeat polls instead — see
// `hardwareListenersAvailable` in player.h.
void Player::registerHardwareListeners()
{
#if JUCE_MAC
    if (nullMode || hardwareListenersRegistered)
        return;
    AudioObjectAddPropertyListener (kAudioObjectSystemObject, &kDefaultOutputAddress,
                                    hardwareChanged, this);
    AudioObjectAddPropertyListener (kAudioObjectSystemObject, &kDeviceListAddress,
                                    hardwareChanged, this);
    hardwareListenersRegistered = true;
#endif
}

void Player::removeHardwareListeners()
{
#if JUCE_MAC
    if (! hardwareListenersRegistered)
        return;
    AudioObjectRemovePropertyListener (kAudioObjectSystemObject, &kDefaultOutputAddress,
                                       hardwareChanged, this);
    AudioObjectRemovePropertyListener (kAudioObjectSystemObject, &kDeviceListAddress,
                                       hardwareChanged, this);
    hardwareListenersRegistered = false;
#endif
}

void Player::refreshAudioDevice()
{
    if (nullMode)
        return;
    auto* type = deviceManager.getCurrentDeviceTypeObject();
    if (type == nullptr)
        return;
    type->scanForDevices();
    auto names = type->getDeviceNames (false);
    if (names.isEmpty())
        return;

    auto* current = deviceManager.getCurrentAudioDevice();
    const bool currentGone = current == nullptr || ! names.contains (current->getName());
    // An explicit selection stands as long as its device exists.
    if (explicitSelection && ! currentGone)
        return;
    if (currentGone)
        explicitSelection = false;

    auto defaultName = names[juce::jmax (0, type->getDefaultDeviceIndex (false))];
    if (! currentGone && current->getName() == defaultName)
        return;

    auto setup = deviceManager.getAudioDeviceSetup();
    setup.outputDeviceName = defaultName;
    deviceManager.setAudioDeviceSetup (setup, false);
    // A loaded file still prefers a device rate that matches it (§3.5).
    if (fileSampleRate > 0)
        maybeMatchDeviceRate (fileSampleRate);
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
                pullAudio (scratch.getArrayOfWritePointers(), 2, nullBlockSize);
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
    registerHardwareListeners();
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
    auto error = deviceManager.setAudioDeviceSetup (setup, true);
    // Only a successful selection pins the device against default-follow.
    if (error.isEmpty())
        explicitSelection = true;
    return error;
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

juce::var Player::load (const juce::File& file, bool loop)
{
    auto result = obj();
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
    if (reader == nullptr)
    {
        result->setProperty ("error", "cannot read audio file: " + file.getFullPathName());
        return juce::var (result.get());
    }
    // One source of audio at a time: a *valid* file load drops any live
    // session — an unreadable path must not leave the player empty
    // (Codex's finding on this PR).
    {
        const juce::ScopedLock guard (liveLock);
        livePlaying = false;
        liveEverStarted = false;
        liveSession.reset();
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

    looping = loop;
    readerSource = std::make_unique<juce::AudioFormatReaderSource> (reader.release(), true);
    readerSource->setLooping (loop);
    // Handing the transport the file's rate is what makes it resample when
    // the device runs at a different one.
    transport.setSource (readerSource.get(), 1 << 15, &readThread, fileSampleRate);
    transport.setPosition (0.0);

    result->setProperty ("samples", fileLengthSamples);
    result->setProperty ("sample_rate", fileSampleRate);
    result->setProperty ("channels", fileChannels);
    return juce::var (result.get());
}

juce::var Player::loadSession (const juce::var& session, const juce::File& projectRoot)
{
    auto result = obj();
    // Freed after the lock releases: a session owns preloaded files and
    // full-length child buffers, and destroying that much under liveLock
    // would hand the callback silent blocks for the whole teardown —
    // pullAudio try-locks and pads on a miss (Codex's finding).
    std::unique_ptr<field::LiveSession> retired;
    try
    {
        // Construction — parsing, preloading, pre-rendering children —
        // happens before the lock: the old session keeps playing through
        // the whole compile, and the swap itself is one pointer move at
        // a block boundary (realtime.md decision 5, chunk 3).
        auto next = std::make_unique<field::LiveSession> (session, projectRoot);
        // Pre-roll outside the lock too: a swap lands at the old
        // session's position, and warming the replacement's chain there
        // (LiveSession::locate) renders seconds of discarded audio —
        // under the lock, that long a hold is a silent gap. The drift
        // between this prediction and the transport read again below is
        // a few blocks, which the second locate rolls forward through a
        // chain that keeps its state.
        {
            juce::int64 predicted = -1;
            {
                const juce::ScopedLock guard (liveLock);
                if (liveSession != nullptr)
                    predicted = liveSession->position();
            }
            if (predicted >= 0)
            {
                if (next->looping() && next->lengthSamples() > 0)
                    predicted %= next->lengthSamples();
                else if (next->lengthSamples() > 0)
                    predicted = std::min (predicted, next->lengthSamples());
                next->locate (predicted);
            }
        }
        const juce::ScopedLock guard (liveLock);
        // Prefer running the device at the session's rate (bit-perfect
        // delivery); when it cannot switch, rebuildLiveConverter below
        // sets up converted delivery instead of refusing
        // (cross-rate-live.md decision 3).
        maybeMatchDeviceRate ((double) next->sessionRate());
        // A swap mid-play carries the transport: latest compile wins and
        // the play never stops. A fresh load (no session before) starts
        // stopped at zero, as ever.
        const bool hadSession = liveSession != nullptr;
        const bool wasPlaying = livePlaying.load();
        juce::int64 carry = hadSession ? liveSession->position() : 0;
        // The session replaces whatever file was loaded — one source of
        // audio at a time, whichever arrived last.
        transport.stop();
        transport.setSource (nullptr);
        readerSource.reset();
        loadedPath.clear();
        everStarted = false;
        livePlaying = false;
        if (! hadSession)
            liveEverStarted = false;
        liveRate = next->sessionRate();
        liveLength = next->lengthSamples();
        liveLoop = next->looping();
        liveSong = session.getProperty ("song", juce::var()).toString();
        retired = std::move (liveSession);
        liveSession = std::move (next);
        if (hadSession)
        {
            if (liveLoop && liveLength > 0)
                carry %= liveLength;
            else if (liveLength > 0)
                carry = std::min (carry, liveLength);
            liveSession->locate (carry);
            livePlaying = wasPlaying;
        }
        rebuildLiveConverter();
    }
    catch (const std::exception& e)
    {
        result->setProperty ("error", juce::String (e.what()));
        return juce::var (result.get());
    }
    result->setProperty ("samples", liveLength);
    result->setProperty ("sample_rate", liveRate);
    result->setProperty ("channels", 2);
    return juce::var (result.get());
}

juce::String Player::liveRamp (const juce::String& track, int input, double gainDb, double rampMs)
{
    if (liveSession == nullptr)
        return "no live session";
    const juce::ScopedLock guard (liveLock);
    try
    {
        liveSession->ramp (track.toStdString(), input, gainDb, rampMs);
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
    return {};
}

juce::String Player::play()
{
    if (liveSession != nullptr)
    {
        liveEverStarted = true;
        livePlaying = true;
        return {};
    }
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
    if (liveSession != nullptr)
    {
        livePlaying = false;
        return;
    }
    transport.stop();
}

void Player::stop()
{
    if (liveSession != nullptr)
    {
        livePlaying = false;
        liveEverStarted = false;
        const juce::ScopedLock guard (liveLock);
        liveSession->locate (0);
        // A transport discontinuity resets delivery conversion to its
        // primed starting state and drops queued output — pre-seek
        // audio never leaks (cross-rate-live.md decision 3).
        rebuildLiveConverter();
        return;
    }
    transport.stop();
    transport.setPosition (0.0);
    everStarted = false;
}

juce::String Player::locate (juce::int64 sample)
{
    if (liveSession != nullptr)
    {
        if (sample < 0 || (! liveLoop && liveLength > 0 && sample > liveLength))
            return "locate out of range";
        const juce::ScopedLock guard (liveLock);
        liveSession->locate (sample);
        rebuildLiveConverter();
        return {};
    }
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
    if (liveSession != nullptr)
        // The session position runs ahead of the ear when delivery
        // converts (it counts what entered the converter), so finished
        // also waits for the converted FIFO to drain — the last taps/2
        // of tail are heard before the transport reports done
        // (cross-rate-live.md decision 3).
        return liveEverStarted && ! liveLoop && liveLength > 0
               && liveSession->position() >= liveLength
               && convQueued.load() == 0;
    // A looping stream never finishes; stop is the only way out.
    return readerSource != nullptr && everStarted && ! looping && transport.hasStreamFinished();
}

juce::String Player::transportState()
{
    if (liveSession != nullptr)
    {
        if (livePlaying.load() && ! streamFinished())
            return "playing";
        if (liveEverStarted && liveSession->position() > 0 && ! streamFinished())
            return "paused";
        return "stopped";
    }
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
    if (liveSession != nullptr)
    {
        const juce::int64 raw = liveSession->position();
        result->setProperty ("sample", liveLoop && liveLength > 0 ? raw % liveLength : raw);
        result->setProperty ("samples", liveLength);
        result->setProperty ("looping", liveLoop);
        result->setProperty ("path", juce::var());
        result->setProperty ("live", true);
        if (liveSong.isNotEmpty())
            result->setProperty ("song", liveSong);
        result->setProperty ("sample_rate", liveRate);
    }
    else
    {
        result->setProperty ("sample", positionSamples());
        result->setProperty ("samples", fileLengthSamples);
        result->setProperty ("looping", looping);
        result->setProperty ("path", loadedPath.isEmpty() ? juce::var() : juce::var (loadedPath));
    }
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
    const double sourceRate = liveSession != nullptr ? (double) liveRate : fileSampleRate;
    result->setProperty ("resampling",
                         (liveSession != nullptr || readerSource != nullptr) && deviceRate > 0.0
                             && ! juce::exactlyEqual (deviceRate, sourceRate));
    return juce::var (result.get());
}

// Reset-and-rebuild for delivery conversion; callers hold liveLock.
// Building fresh *is* the reset the plan specifies: the resampler's
// primed-with-zeros starting state, an empty FIFO, nothing queued.
void Player::rebuildLiveConverter()
{
    liveConverter.reset();
    convOut.assign (2, std::vector<float>());
    convOutRead = 0;
    convFlushed = false;
    convQueued.store (0);
    if (liveSession == nullptr || liveRate <= 0)
        return;
    const double deviceRate = nullMode
                                  ? nullSampleRate
                                  : (deviceManager.getCurrentAudioDevice() != nullptr
                                         ? deviceManager.getCurrentAudioDevice()
                                               ->getCurrentSampleRate()
                                         : 0.0);
    if (deviceRate <= 0.0 || juce::exactlyEqual (deviceRate, (double) liveRate))
        return;
    liveConverter = std::make_unique<field::dsp::Resampler> ((double) liveRate, deviceRate, 2);
    convIn.assign (2, std::vector<float>());
    // Reserved so the callback's process/push_back stays off the heap
    // in steady state; the compaction below keeps the FIFO inside this.
    for (auto& ch : convIn)
        ch.reserve (512);
    for (auto& ch : convOut)
        ch.reserve (1 << 16);
}

void Player::pullAudio (float* const* out, int numChannels, int n)
{
    {
        // The pointer is only readable under the lock (cursor's finding:
        // checking it first races a message-thread load). A missed lock
        // is one silent block during a rare edit, not a glitch.
        const juce::ScopedTryLock guard (liveLock);
        if (! guard.isLocked())
        {
            for (int c = 0; c < numChannels; ++c)
                std::fill (out[c], out[c] + n, 0.0f);
            return;
        }
        if (liveSession != nullptr)
        {
            if (livePlaying.load())
            {
                if (liveConverter == nullptr)
                {
                    liveSession->renderBlock (out, numChannels, n);
                    return;
                }
                // Converted delivery: render session-rate blocks into
                // the resampler until n device frames wait in the FIFO.
                // Past the session's extent the input is silence, which
                // pushes the kernel's tail through; the final remainder
                // arrives via one flush, after which the FIFO drains to
                // empty and streamFinished may fire.
                const int step = 512;
                while ((juce::int64) (convOut[0].size() - convOutRead) < (juce::int64) n
                       && ! convFlushed)
                {
                    for (auto& ch : convIn)
                        ch.assign ((size_t) step, 0.0f);
                    float* ins[2] = { convIn[0].data(), convIn[1].data() };
                    liveSession->renderBlock (ins, 2, step);
                    liveConverter->process (convIn, convOut);
                    if (! liveLoop && liveLength > 0
                        && liveSession->position() >= liveLength)
                    {
                        liveConverter->flush (convOut);
                        convFlushed = true;
                    }
                }
                const juce::int64 have = (juce::int64) (convOut[0].size() - convOutRead);
                const int give = (int) std::min<juce::int64> (n, have);
                for (int c = 0; c < numChannels; ++c)
                {
                    const auto& src = convOut[(size_t) std::min (c, 1)];
                    for (int i = 0; i < n; ++i)
                        out[c][i] = c < 2 && i < give ? src[convOutRead + (size_t) i] : 0.0f;
                }
                convOutRead += (size_t) give;
                convQueued.store ((juce::int64) (convOut[0].size() - convOutRead));
                if (convOutRead > (size_t) (1 << 15))
                {
                    // memmove, not allocation: capacity stays put.
                    for (auto& ch : convOut)
                        ch.erase (ch.begin(), ch.begin() + (std::ptrdiff_t) convOutRead);
                    convOutRead = 0;
                }
                return;
            }
            for (int c = 0; c < numChannels; ++c)
                std::fill (out[c], out[c] + n, 0.0f);
            return;
        }
    }
    juce::AudioBuffer<float> buffer (const_cast<float**> (out), numChannels, n);
    juce::AudioSourceChannelInfo info (&buffer, 0, n);
    transport.getNextAudioBlock (info);
}

void Player::audioDeviceIOCallbackWithContext (const float* const*, int,
                                               float* const* outputChannelData,
                                               int numOutputChannels,
                                               int numSamples,
                                               const juce::AudioIODeviceCallbackContext&)
{
    pullAudio (outputChannelData, numOutputChannels, numSamples);
}

void Player::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    transport.prepareToPlay (device->getCurrentBufferSizeSamples(), device->getCurrentSampleRate());
    // A device start is where a rate change becomes real (hot-plug,
    // default-follow, an explicit selection): rebuild the delivery
    // conversion against the rate the callback is about to run at.
    const juce::ScopedLock guard (liveLock);
    rebuildLiveConverter();
}

void Player::audioDeviceStopped()
{
    transport.releaseResources();
}
