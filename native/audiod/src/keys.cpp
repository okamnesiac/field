#include "keys.h"

#include "keyboard-layout.h"

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_events/juce_events.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <poll.h>
#include <unistd.h>
#endif

#include <atomic>
#include <csignal>
#include <cstdio>
#include <initializer_list>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace field
{
namespace
{
std::mutex stdoutLock;

void printLine (const juce::var& value)
{
    const auto line = juce::JSON::toString (value,
                                            juce::JSON::FormatOptions{}.withSpacing (
                                                juce::JSON::Spacing::none))
                      + "\n";
    const std::scoped_lock lock (stdoutLock);
    std::fputs (line.toRawUTF8(), stdout);
    std::fflush (stdout);
}

juce::var jsonObject (std::initializer_list<std::pair<juce::Identifier, juce::var>> properties)
{
    juce::DynamicObject::Ptr object = new juce::DynamicObject();
    for (const auto& [name, value] : properties)
        object->setProperty (name, value);
    return juce::var (object.get());
}

void printError (const juce::String& message)
{
    printLine (jsonObject ({ { "error", message } }));
}

juce::String fromUtf8 (const std::string& text)
{
    return juce::String::fromUTF8 (text.data(), (int) text.size());
}

void printKeyboardLayout()
{
    const auto layout = readKeyboardLayout();
    if (! layout)
        return;

    juce::DynamicObject::Ptr keys = new juce::DynamicObject();
    for (const auto& [position, typed] : layout->keys)
        keys->setProperty (juce::Identifier (position.c_str()), fromUtf8 (typed));

    juce::Array<juce::var> dead;
    for (const auto& position : layout->dead)
        dead.add (fromUtf8 (position));

    printLine (jsonObject ({ { "keyboard", jsonObject ({ { "name", fromUtf8 (layout->name) },
                                                         { "keys", juce::var (keys.get()) },
                                                         { "dead", dead } }) } }));
}

// Reads one {"midi":[...]} line into message, or returns why it is not one.
juce::String readMidiLine (const juce::String& line, juce::MidiMessage& message)
{
    juce::var parsed;
    if (juce::JSON::parse (line, parsed).failed() || parsed.getDynamicObject() == nullptr
        || parsed.getDynamicObject()->getProperties().size() != 1
        || ! parsed["midi"].isArray())
        return "expected a line like {\"midi\":[144,60,100]}, got " + line;

    const auto& bytes = *parsed["midi"].getArray();
    if (bytes.isEmpty() || bytes.size() > 3)
        return "a MIDI message is 1 to 3 bytes, got " + juce::String (bytes.size()) + " in " + line;

    juce::uint8 data[3] {};
    for (int i = 0; i < bytes.size(); ++i)
    {
        const auto& byte = bytes.getReference (i);
        if (! (byte.isInt() || byte.isInt64()) || (juce::int64) byte < 0 || (juce::int64) byte > 255)
            return "a MIDI byte is an integer from 0 to 255, got " + juce::JSON::toString (byte, true)
                   + " in " + line;
        data[i] = (juce::uint8) (int) byte;
    }
    if (data[0] < 0x80)
        return "a MIDI message starts with a status byte, 128 or above, got "
               + juce::String (data[0]) + " in " + line;

    message = juce::MidiMessage (data, bytes.size());
    return {};
}

class MidiPrinter final : public juce::MidiInputCallback
{
public:
    void handleIncomingMidiMessage (juce::MidiInput*, const juce::MidiMessage& message) override
    {
        juce::Array<juce::var> bytes;
        for (int i = 0; i < message.getRawDataSize(); ++i)
            bytes.add ((int) message.getRawData()[i]);
        printLine (jsonObject ({ { "midi", bytes } }));
    }
};

std::unique_ptr<juce::MidiInput> openSource (const juce::String& name, juce::MidiInputCallback& callback)
{
    for (const auto& device : juce::MidiInput::getAvailableDevices())
        if (device.name == name)
            return juce::MidiInput::openDevice (device.identifier, &callback);
    return nullptr;
}

// Drains whatever stdin holds without blocking, and says whether it has
// reached end of input.
bool stdinEnded()
{
#if defined(_WIN32)
    // Windows has no poll on a pipe; PeekNamedPipe is its non-blocking
    // question. The monitor's stdin is the pipe its parent spawned it with,
    // and a closed write end reads as ERROR_BROKEN_PIPE. Any other handle,
    // a console included, is never "ended" here, as poll would say.
    const HANDLE in = GetStdHandle (STD_INPUT_HANDLE);
    for (;;)
    {
        DWORD available = 0;
        if (PeekNamedPipe (in, nullptr, 0, nullptr, &available, nullptr) == 0)
            return GetLastError() == ERROR_BROKEN_PIPE;
        if (available == 0)
            return false;
        char discarded[256];
        DWORD got = 0;
        const DWORD want = available < sizeof (discarded) ? available : (DWORD) sizeof (discarded);
        if (ReadFile (in, discarded, want, &got, nullptr) == 0 || got == 0)
            return true;
    }
#else
    pollfd stdinPoll { STDIN_FILENO, POLLIN, 0 };
    while (poll (&stdinPoll, 1, 0) > 0)
    {
        char discarded[256];
        if (read (STDIN_FILENO, discarded, sizeof (discarded)) <= 0)
            return true;
    }
    return false;
#endif
}

// The system output's name, which the voice host names as scsynth's input
// device too: scsynth on macOS otherwise opens the default input device
// even with no input channels, and blocks on the microphone permission
// (keyboard-instrument.md §10.1).
juce::String defaultOutputDevice()
{
#if JUCE_MAC
    std::unique_ptr<juce::AudioIODeviceType> type (juce::AudioIODeviceType::createAudioIODeviceType_CoreAudio());
    if (type == nullptr)
        return {};
    type->scanForDevices();
    const auto names = type->getDeviceNames (false);
    const auto index = type->getDefaultDeviceIndex (false);
    return juce::isPositiveAndBelow (index, names.size()) ? names[index] : juce::String();
#else
    return {};
#endif
}

std::atomic<bool> stopRequested { false };
} // namespace

int runKeys (const juce::String& name)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    // Watching starts before the first report, so a switch between the two
    // still produces a report.
    const KeyboardLayoutWatcher watcher (printKeyboardLayout);
    printKeyboardLayout();

    // JUCE declares createNewDevice only where the OS lets a process
    // publish a MIDI port (macOS, Linux); Windows has no virtual ports, so
    // there the helper refuses below with the same message as a failure.
#if JUCE_WINDOWS
    std::unique_ptr<juce::MidiOutput> source;
#else
    auto source = juce::MidiOutput::createNewDevice (name);
#endif
    if (source == nullptr)
    {
        printError ("cannot create a virtual MIDI source named " + name + " on this system");
        return 1;
    }
    auto ready = jsonObject ({ { "ready", true }, { "name", name } });
    const auto output = defaultOutputDevice();
    if (output.isNotEmpty())
        ready.getDynamicObject()->setProperty ("output", output);
    printLine (ready);

    // Lines are read off the main thread, whose run loop delivers the
    // keyboard layout changes, and each message is sent as its line
    // arrives.
    std::atomic<int> exitCode { -1 };
    std::thread reader ([&]
    {
        std::string line;
        while (std::getline (std::cin, line))
        {
            const auto text = fromUtf8 (line).trim();
            if (text.isEmpty())
                continue;

            juce::MidiMessage message;
            if (const auto error = readMidiLine (text, message); error.isNotEmpty())
            {
                printError (error);
                exitCode = 1;
                return;
            }
            source->sendMessageNow (message);
        }
        exitCode = 0;
    });

    while (exitCode < 0)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
    reader.join();
    source.reset();
    return exitCode;
}

int runMidiMonitor (const juce::String& name)
{
    juce::ScopedJuceInitialiser_GUI juceInit;
    auto* messageManager = juce::MessageManager::getInstance();

    MidiPrinter printer;
    const auto giveUpAt = juce::Time::currentTimeMillis() + 5000;
    auto input = openSource (name, printer);
    while (input == nullptr && juce::Time::currentTimeMillis() < giveUpAt)
    {
        messageManager->runDispatchLoopUntil (100);
        input = openSource (name, printer);
    }
    if (input == nullptr)
    {
        printError ("no MIDI source named " + name);
        return 1;
    }

    std::signal (SIGTERM, [] (int) { stopRequested = true; });
    std::signal (SIGINT, [] (int) { stopRequested = true; });
    input->start();
    printLine (jsonObject ({ { "ready", true }, { "name", name } }));

    while (! stopRequested && ! stdinEnded())
        messageManager->runDispatchLoopUntil (100);

    input->stop();
    return 0;
}
} // namespace field
