#include "player.h"
#include "server.h"

#include <juce_events/juce_events.h>

#include <csignal>

// bloom-audiod: the playback daemon (playback.md). Spawned on demand by the
// CLI with its working directory at the project root, serves the NDJSON
// control socket at .bloom/audiod.sock, and exits on its own after an idle
// timeout — daemon-lite (§3.1). Artifacts only: it plays files the build
// produced and has no idea what a clip or a bar is.

namespace
{
juce::String jsonEvent (const juce::String& name,
                        const std::function<void (juce::DynamicObject&)>& fill)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty ("event", name);
    fill (*o);
    return juce::JSON::toString (juce::var (o.get()), true) + "\n";
}

// Runs on the message thread: emits state transitions and position events,
// turns natural end-of-stream into a stop, and asks the daemon to exit
// when idle.
class Heartbeat : public juce::Timer
{
public:
    Heartbeat (Player& p, Server& s, int idleSeconds)
        : player (p), server (s), idleMs ((juce::int64) idleSeconds * 1000)
    {
        lastKnownState = player.transportState();
        // Baseline the device too, or the first tick broadcasts the
        // spawn-time output as a phantom "moved" event (#16 review).
        lastKnownDevice = player.status()
                              .getProperty ("device", juce::var())
                              .getProperty ("name", juce::var())
                              .toString();
        startTimer (250);
    }

    std::atomic<bool> wantExit { false };

    void timerCallback() override
    {
        server.sweepClosedConnections();

        if (player.streamFinished())
            player.stop();

        auto status = player.status();

        auto state = player.transportState();
        if (state != lastKnownState)
        {
            lastKnownState = state;
            server.broadcast (jsonEvent ("state", [&] (juce::DynamicObject& o)
                                         { o.setProperty ("state", state); }));
        }

        // The output can move underneath a client (default-follow, device
        // vanishing): say so on the socket.
        auto device = status.getProperty ("device", juce::var());
        auto deviceName = device.getProperty ("name", juce::var()).toString();
        if (deviceName != lastKnownDevice)
        {
            lastKnownDevice = deviceName;
            if (deviceName.isNotEmpty())
                server.broadcast (jsonEvent ("device", [&] (juce::DynamicObject& o)
                {
                    o.setProperty ("name", deviceName);
                    o.setProperty ("sample_rate", device.getProperty ("sample_rate", 0));
                }));
        }

        if (state == "playing")
        {
            auto sample = (juce::int64) status.getProperty ("sample", 0);
            server.broadcast (jsonEvent ("position", [&] (juce::DynamicObject& o)
                                         { o.setProperty ("sample", sample); }));
        }

        auto idle = server.connectionCount() == 0 && state != "playing"
                    && juce::Time::currentTimeMillis() - server.lastActivityMs() > idleMs;
        if (server.quitRequested || idle)
            wantExit = true;
    }

private:
    Player& player;
    Server& server;
    const juce::int64 idleMs;
    juce::String lastKnownState;
    juce::String lastKnownDevice;
};
} // namespace

int main (int argc, char* argv[])
{
    juce::String socketPath = ".bloom/audiod.sock";
    bool nullOutput = false;
    int idleSeconds = 300;

    for (int i = 1; i < argc; ++i)
    {
        juce::String arg (argv[i]);
        if (arg == "--socket" && i + 1 < argc)
            socketPath = argv[++i];
        else if (arg == "--null-output")
            nullOutput = true;
        else if (arg == "--idle" && i + 1 < argc)
            idleSeconds = juce::String (argv[++i]).getIntValue();
        else
        {
            std::fprintf (stderr,
                          "usage: bloom-audiod [--socket <path>] [--null-output] [--idle <seconds>]\n");
            return 2;
        }
    }

    // Belt to SO_NOSIGPIPE's suspenders: a write to a dying client must be
    // an error return, never a process-killing signal.
    std::signal (SIGPIPE, SIG_IGN);

    juce::ScopedJuceInitialiser_GUI juceInit;

    Player player (nullOutput);
    if (auto error = player.initialise(); error.isNotEmpty())
    {
        std::fprintf (stderr, "bloom-audiod: audio init failed: %s\n", error.toRawUTF8());
        return 1;
    }

    Server server (player, socketPath);
    if (auto error = server.start(); error.isNotEmpty())
    {
        std::fprintf (stderr, "bloom-audiod: %s\n", error.toRawUTF8());
        return 1;
    }

    Heartbeat heartbeat (player, server, idleSeconds);
    // runDispatchLoopUntil rather than runDispatchLoop: the daemon has no
    // NSApplication, and the bounded variant reliably drives timers and
    // async callbacks in a plain console process.
    while (! heartbeat.wantExit)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (100);

    // Drain before destruction, still dispatching: a reader parked on a
    // MessageManagerLock is only released by this loop, so leaving it with
    // live readers would deadlock ~Server's join (#12 review). Progress is
    // guaranteed — each pass grants pending locks, finished readers mark
    // themselves closed, the sweep reaps them.
    server.beginShutdown();
    while (server.connectionCount() > 0)
    {
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);
        server.sweepClosedConnections();
    }
    server.sweepClosedConnections();
    return 0;
}
