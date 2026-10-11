#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

class Player;

// The versioned NDJSON control socket (playback.md §3.3): one JSON object
// per line, request/response with client-chosen ids, plus broadcast events.
// JUCE's StreamingSocket is TCP-only, so the transport is by hand on both
// platforms: AF_UNIX on POSIX, with the socket path bound relative to the
// daemon's working directory (the project root) to stay inside sun_path's
// 104 bytes (§3.2); a named pipe on Windows, where the CLI hands the full
// \\.\pipe\ name via --socket and no length limit applies
// (windows-portability.md §2.1, §2.3). The request handling — framing,
// dispatch, broadcast — is shared; only the I/O layer splits.
class Server
{
public:
    Server (Player& player, juce::String relativeSocketPath);
    ~Server();

    // Empty string on success. Refuses to start if a live daemon already
    // owns the socket; replaces a stale socket file.
    juce::String start();

    // Phase one of shutdown, called while the message loop is still
    // dispatching: stop accepting and half-close every connection's read
    // side so readers drain out. A reader mid-request may be waiting on a
    // MessageManagerLock, which only the still-running loop can grant —
    // shutting down after leaving the loop deadlocks join() against that
    // wait (#12 review). main.cpp keeps dispatching until
    // connectionCount() reaches zero, then destruction joins nothing live.
    void beginShutdown();

    void broadcast (const juce::String& line);

    // Joins and removes finished connections. Called from the heartbeat: a
    // reader thread must never destroy its own Connection (a joinable
    // std::thread destructor is std::terminate), so readers only mark
    // themselves closed and the message thread reaps them.
    void sweepClosedConnections();

    int connectionCount();
    juce::int64 lastActivityMs() const { return lastActivity.load(); }

    // Set when a client sends {"op":"quit"}; main.cpp winds down the loop.
    std::atomic<bool> quitRequested { false };

private:
    struct Connection
    {
#if defined(_WIN32)
        void* pipe = nullptr; // HANDLE, spelled void* to keep windows.h out of this header
#else
        int fd = -1;
#endif
        std::thread reader;
        std::mutex writeMutex;
        std::atomic<bool> open { true };
    };

    void acceptLoop();
    void readLoop (std::shared_ptr<Connection> connection);
    void handleLine (Connection& connection, const juce::String& line);
    void send (Connection& connection, const juce::String& line);
    juce::String dispatch (const juce::var& request); // returns response JSON line

    Player& player;
    const juce::String socketPath;
#if defined(_WIN32)
    // The instance parked in ConnectNamedPipe, and the manual-reset event
    // its OVERLAPPED waits on — beginShutdown signals it so the accept
    // thread wakes without a client ever arriving. The first instance is
    // created with FILE_FLAG_FIRST_PIPE_INSTANCE, which is the flock:
    // a second daemon on the same name fails at creation.
    void* pendingPipe = nullptr; // HANDLE
    void* acceptEvent = nullptr; // HANDLE
#else
    int lockFd = -1; // flock held for the daemon's life (single-owner guarantee)
    int listenFd = -1;
#endif
    std::thread acceptThread;
    std::atomic<bool> running { false };
    std::mutex connectionsMutex;
    std::vector<std::shared_ptr<Connection>> connections;
    std::atomic<juce::int64> lastActivity { 0 };
};
