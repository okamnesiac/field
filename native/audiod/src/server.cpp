#include "server.h"
#include "player.h"

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

    // If a daemon already owns this socket, defer to it; a socket file
    // nobody answers is a stale leftover from a crash and gets replaced.
    int probe = ::socket (AF_UNIX, SOCK_STREAM, 0);
    if (probe >= 0)
    {
        if (::connect (probe, (sockaddr*) &addr, sizeof (addr)) == 0)
        {
            ::close (probe);
            return "another bloom-audiod already owns " + socketPath;
        }
        ::close (probe);
    }
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
        // A client may vanish between our poll and our write (ctrl-c mid
        // position stream); without this, that write is a fatal SIGPIPE.
        int noSigpipe = 1;
        ::setsockopt (fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, sizeof (noSigpipe));
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
        ok->setProperty ("daemon", "bloom-audiod");
        ok->setProperty ("version", "0.1.0");
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
        auto info = player.load (juce::File (path));
        if (info.getProperty ("error", juce::var()).isString())
            return jsonLine (errorResponse (id, info.getProperty ("error", juce::var()).toString()));
        if (auto* o = info.getDynamicObject())
            for (auto& prop : o->getProperties())
                ok->setProperty (prop.name, prop.value);
    }
    else if (op == "play")
    {
        auto error = player.play();
        if (error.isNotEmpty())
            return jsonLine (errorResponse (id, error));
    }
    else if (op == "pause")
    {
        player.pause();
    }
    else if (op == "stop")
    {
        player.stop();
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
