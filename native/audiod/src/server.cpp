#include "server.h"
#include "player.h"
#include "version.h"

#include <fcntl.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace
{
constexpr int protocolVersion = 1;

juce::String jsonLine (const juce::var& v)
{
    return juce::JSON::toString (v, true) + "\n";
}

juce::DynamicObject::Ptr obj() { return new juce::DynamicObject(); }

juce::var errorResponse (const juce::var& id, const juce::String& message)
{
    auto o = obj();
    if (! id.isVoid())
        o->setProperty ("id", id);
    o->setProperty ("ok", false);
    o->setProperty ("error", message);
    return juce::var (o.get());
}
} // namespace

Server::Server (Player& p, juce::String relativeSocketPath)
    : player (p), socketPath (std::move (relativeSocketPath))
{
}

Server::~Server()
{
    running = false;
    if (listenFd >= 0)
    {
        ::shutdown (listenFd, SHUT_RDWR);
        ::close (listenFd);
        ::unlink (socketPath.toRawUTF8());
    }
    if (lockFd >= 0)
        ::close (lockFd); // releases the flock; the lock file itself stays
    if (acceptThread.joinable())
        acceptThread.join();

    std::vector<std::shared_ptr<Connection>> toClose;
    {
        const std::lock_guard<std::mutex> lock (connectionsMutex);
        toClose = connections;
        connections.clear();
    }
    for (auto& c : toClose)
    {
        c->open = false;
        ::shutdown (c->fd, SHUT_RDWR);
        ::close (c->fd);
        if (c->reader.joinable())
            c->reader.join();
    }
}

juce::String Server::start()
{
    if (socketPath.length() >= (int) sizeof (sockaddr_un::sun_path))
        return "socket path too long: " + socketPath;

    sockaddr_un addr {};
    addr.sun_family = AF_UNIX;
    std::snprintf (addr.sun_path, sizeof (addr.sun_path), "%s", socketPath.toRawUTF8());

    // Exactly one daemon per socket, decided by flock rather than a
    // connect probe: two daemons spawned in the same instant could each
    // fail the probe and unlink the other's freshly bound socket (#12
    // review). The lock is held for the daemon's whole life and the OS
    // releases it on any death, so it cannot go stale; with the lock won,
    // any existing socket file is by definition a dead daemon's leftover.
    // The lock file itself is never unlinked — removing it would reopen
    // the race for the next pair of spawns.
    lockFd = ::open ((socketPath + ".lock").toRawUTF8(), O_CREAT | O_RDWR, 0600);
    if (lockFd < 0)
        return "cannot open lock file: " + juce::String (strerror (errno));
    if (::flock (lockFd, LOCK_EX | LOCK_NB) != 0)
        return "another field-audiod already owns " + socketPath;
    ::unlink (socketPath.toRawUTF8());

    listenFd = ::socket (AF_UNIX, SOCK_STREAM, 0);
    if (listenFd < 0)
        return "socket() failed: " + juce::String (strerror (errno));
    if (::bind (listenFd, (sockaddr*) &addr, sizeof (addr)) != 0)
        return "bind() failed for " + socketPath + ": " + juce::String (strerror (errno));
    if (::listen (listenFd, 8) != 0)
        return "listen() failed: " + juce::String (strerror (errno));

    lastActivity = juce::Time::currentTimeMillis();
    running = true;
    acceptThread = std::thread ([this] { acceptLoop(); });
    return {};
}

void Server::acceptLoop()
{
    while (running)
    {
        int fd = ::accept (listenFd, nullptr, nullptr);
        if (fd < 0)
        {
            if (running)
                continue;
            break;
        }
        auto connection = std::make_shared<Connection>();
        connection->fd = fd;
        {
            const std::lock_guard<std::mutex> lock (connectionsMutex);
            connections.push_back (connection);
        }
        lastActivity = juce::Time::currentTimeMillis();
        connection->reader = std::thread ([this, connection] { readLoop (connection); });
        // A connection accepted in the same instant as beginShutdown would
        // miss its half-close and stall the drain loop; catch it here.
        if (! running)
            ::shutdown (fd, SHUT_RD);
    }
}

void Server::readLoop (std::shared_ptr<Connection> connection)
{
    std::string buffer;
    char chunk[4096];
    while (connection->open)
    {
        auto n = ::read (connection->fd, chunk, sizeof (chunk));
        if (n <= 0)
            break;
        buffer.append (chunk, (size_t) n);
        size_t newline;
        while ((newline = buffer.find ('\n')) != std::string::npos)
        {
            auto line = buffer.substr (0, newline);
            buffer.erase (0, newline + 1);
            if (! line.empty())
                handleLine (*connection, juce::String::fromUTF8 (line.c_str(), (int) line.size()));
        }
    }
    lastActivity = juce::Time::currentTimeMillis();
    // Last: the sweep only joins threads whose connection is closed, and
    // everything above must be finished by then. The fd is closed by the
    // sweep too — exactly one closer, so a reused descriptor can never be
    // closed out from under a newer connection.
    connection->open = false;
}

void Server::sweepClosedConnections()
{
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto it = connections.begin(); it != connections.end();)
    {
        if (! (*it)->open)
        {
            if ((*it)->reader.joinable())
                (*it)->reader.join();
            ::close ((*it)->fd);
            it = connections.erase (it);
        }
        else
        {
            ++it;
        }
    }
}

void Server::handleLine (Connection& connection, const juce::String& line)
{
    lastActivity = juce::Time::currentTimeMillis();
    auto request = juce::JSON::parse (line);
    juce::String response;
    if (! request.isObject())
    {
        response = jsonLine (errorResponse (juce::var(), "invalid JSON"));
    }
    else if (request.getProperty ("op", juce::var()).toString() == "session")
    {
        // The one op dispatched without the blanket lock: session
        // construction instantiates plugins, and JUCE's create posts to
        // the message thread and waits — under the lock that wait is on
        // this thread's own lock, and the daemon hangs (minjudd's P1 on
        // #150). loadSession builds lock-free and takes the lock itself
        // for the install, so player state stays message-thread-owned
        // and the heavy build no longer serializes other connections'
        // requests.
        response = dispatch (request);
    }
    else
    {
        // Player state belongs to the message thread; every request takes
        // the lock, which also serializes requests across connections.
        const juce::MessageManagerLock mml;
        response = dispatch (request);
    }
    send (connection, response);
}

juce::String Server::dispatch (const juce::var& request)
{
    auto id = request.getProperty ("id", juce::var());
    auto op = request.getProperty ("op", juce::var()).toString();
    auto ok = obj();
    if (! id.isVoid())
        ok->setProperty ("id", id);
    ok->setProperty ("ok", true);

    if (op == "hello")
    {
        ok->setProperty ("protocol", protocolVersion);
        ok->setProperty ("daemon", "field-audiod");
        ok->setProperty ("version", field::daemonVersion);
        // So a client can tell a stale daemon apart from a live one by
        // more than its answers — and so a test can kill this process
        // mid-take to prove the transaction survives.
        ok->setProperty ("pid", (int) ::getpid());
        // Capability names (realtime.md §3): clients gate on these, not
        // on parsing the version string.
        juce::Array<juce::var> features;
        features.add ("loop");
        features.add ("session");
        // The session verb replaces mid-play with the transport carried
        // (chunk 3). 0.5 advertised `session` too, with a swap that
        // stopped and rewound — so the watch path gates on this feature,
        // not that one (Codex's finding).
        features.add ("swap");
        // The input side (recording.md §6): arm, disarm, record, the
        // recordings list and recover, `record` in status, the `record`
        // and `take` events, and stop finalizing a take.
        features.add ("record");
        ok->setProperty ("features", features);
    }
    else if (op == "devices")
    {
        auto devices = player.deviceList();
        if (auto* o = devices.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "device.select")
    {
        auto error = player.selectDevice (request.getProperty ("name", juce::var()).toString());
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "load")
    {
        auto path = request.getProperty ("path", juce::var()).toString();
        auto loop = (bool) request.getProperty ("loop", false);
        auto info = player.load (juce::File (path), loop);
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "session")
    {
        // The compiled live session (session.ts): rendered by the
        // engine from this moment; paths resolve against the daemon's
        // working directory, which is the project root.
        auto info = player.loadSession (request.getProperty ("session", juce::var()),
                                        juce::File::getCurrentWorkingDirectory());
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "ramp")
    {
        auto error = player.liveRamp (request.getProperty ("track", juce::var()).toString(),
                                      (int) request.getProperty ("input", juce::var (0)),
                                      (double) request.getProperty ("gain_db", juce::var (0.0)),
                                      (double) request.getProperty ("ramp_ms", juce::var (15.0)));
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "play")
    {
        auto error = player.play();
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "pause")
    {
        // Both end a take in progress (player.cpp: a capture against a
        // still transport has no honest placement), and both hand the
        // finalized manifest back so the caller that ended it has it
        // without a second round-trip; the `take` event reaches everyone
        // else.
        auto take = player.stopRecording();
        player.pause();
        if (take.isObject() && ! take.hasProperty ("error"))
            ok->setProperty ("take", take);
    }
    else if (op == "stop")
    {
        auto take = player.stopRecording();
        player.stop();
        if (take.isObject() && ! take.hasProperty ("error"))
            ok->setProperty ("take", take);
    }
    else if (op == "arm")
    {
        auto input = request.getProperty ("input", juce::var (1));
        if (! input.isInt() && ! input.isInt64() && ! input.isDouble())
            return jsonLine (errorResponse (id, "arm needs an input channel number"));
        auto info = player.arm (request.getProperty ("track", juce::var()).toString(),
                                request.getProperty ("device", juce::var()).toString(),
                                (int) input);
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "disarm")
    {
        auto error = player.disarm();
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "record")
    {
        auto info = player.record (request.getProperty ("at", juce::var()));
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "recordings")
    {
        ok->setProperty ("recordings", player.recordings());
    }
    else if (op == "recover")
    {
        // `transaction`, not `id`: the request's id is the request's.
        auto info = player.recover (request.getProperty ("transaction", juce::var()).toString());
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        ok->setProperty ("take", info);
    }
    else if (op == "locate")
    {
        auto sample = request.getProperty ("sample", juce::var());
        if (! sample.isInt() && ! sample.isInt64() && ! sample.isDouble())
            return jsonLine (errorResponse (id, "locate needs a sample number"));
        auto error = player.locate ((juce::int64) sample);
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "status")
    {
        auto s = player.status();
        if (auto* o = s.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "quit")
    {
        quitRequested = true;
    }
    else
    {
        return jsonLine (errorResponse (id, "unknown op: " + op));
    }
    return jsonLine (juce::var (ok.get()));
}

void Server::send (Connection& connection, const juce::String& line)
{
    const std::lock_guard<std::mutex> lock (connection.writeMutex);
    auto utf8 = line.toRawUTF8();
    auto remaining = strlen (utf8);
    while (remaining > 0 && connection.open)
    {
        // A client may vanish between our poll and this write (ctrl-c mid
        // position stream). SIGPIPE is ignored process-wide (main.cpp), so
        // that write returns EPIPE and the loop below stops. There is
        // deliberately no second mechanism — see the note there.
        auto n = ::write (connection.fd, utf8, remaining);
        if (n <= 0)
            break;
        utf8 += n;
        remaining -= (size_t) n;
    }
}

void Server::beginShutdown()
{
    running = false;
    if (listenFd >= 0)
        ::shutdown (listenFd, SHUT_RDWR);
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    for (auto& connection : connections)
        if (connection->open)
            ::shutdown (connection->fd, SHUT_RD); // write side stays up for in-flight responses
}

void Server::broadcast (const juce::String& line)
{
    std::vector<std::shared_ptr<Connection>> current;
    {
        const std::lock_guard<std::mutex> lock (connectionsMutex);
        current = connections;
    }
    for (auto& connection : current)
        if (connection->open)
            send (*connection, line);
}

int Server::connectionCount()
{
    const std::lock_guard<std::mutex> lock (connectionsMutex);
    int open = 0;
    for (auto& connection : connections)
        if (connection->open)
            ++open;
    return open;
}
