#include "ring_input.h"

#include "field_ring.h"

#include "dsp/wavfile.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <new>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

namespace field
{

RingInput::RingInput (uint32_t sampleRate, uint32_t capacity) : frames (capacity)
{
#if defined(_WIN32)
    juce::ignoreUnused (sampleRate);
    throw std::runtime_error ("live inputs need POSIX shared memory, which the Windows build does not have yet");
#else
    if (capacity == 0 || (capacity & (capacity - 1)) != 0)
        throw std::runtime_error ("a ring's capacity is a power of two");
    bytes = ring::bytesFor (capacity);
    std::random_device seed;
    std::mt19937 pick (seed());
    std::uniform_int_distribution<uint32_t> number (1, ring::maxId - 1);
    for (int attempt = 0; attempt < 16 && ! linked; ++attempt)
    {
        const uint32_t candidate = number (pick);
        char name[32];
        ring::nameFor (candidate, name);
        const int fd = shm_open (name, O_CREAT | O_EXCL | O_RDWR, 0600);
        if (fd < 0)
        {
            if (errno == EEXIST)
                continue;
            throw std::runtime_error (std::string ("shm_open: ") + std::strerror (errno));
        }
        if (ftruncate (fd, (off_t) bytes) != 0)
        {
            const int error = errno;
            ::close (fd);
            shm_unlink (name);
            throw std::runtime_error (std::string ("sizing the ring: ") + std::strerror (error));
        }
        mapped = mmap (nullptr, bytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        ::close (fd);
        if (mapped == MAP_FAILED)
        {
            mapped = nullptr;
            shm_unlink (name);
            throw std::runtime_error ("the ring would not map");
        }
        ringId = candidate;
        linked = true;
    }
    if (! linked)
        throw std::runtime_error ("no free ring number after 16 tries");
    // The object starts zeroed (ftruncate), so the counters already read
    // zero; the rest says what the writer is looking at.
    auto* header = new (mapped) ring::Header {};
    header->magic = ring::magic;
    header->version = ring::version;
    header->channels = ring::channels;
    header->capacity = capacity;
    header->sampleRate = sampleRate;
#endif
}

RingInput::~RingInput()
{
#if ! defined(_WIN32)
    retire();
    if (mapped != nullptr)
        munmap (mapped, bytes);
#endif
}

void RingInput::retire()
{
#if ! defined(_WIN32)
    if (! linked)
        return;
    char name[32];
    ring::nameFor (ringId, name);
    shm_unlink (name);
    linked = false;
#endif
}

void RingInput::read (float* left, float* right, int n)
{
    int taken = 0;
#if ! defined(_WIN32)
    auto* header = static_cast<ring::Header*> (mapped);
    const uint64_t written = header->written.load (std::memory_order_acquire);
    uint64_t held = written - at;
    const uint64_t target = (uint64_t) n + writerBurst;
    if (! primed && held >= target)
        primed = true;
    if (primed)
    {
        if (held > 2 * target)
        {
            const uint64_t drop = held - target;
            at += drop;
            held = target;
            skipped.fetch_add (drop, std::memory_order_relaxed);
        }
        taken = (int) std::min<uint64_t> (held, (uint64_t) n);
        const float* data = ring::data (header);
        const uint64_t mask = frames - 1;
        float loudest = 0.0f;
        for (int i = 0; i < taken; ++i)
        {
            const size_t from = (size_t) ((at + (uint64_t) i) & mask) * ring::channels;
            left[i] = data[from];
            right[i] = data[from + 1];
            loudest = std::max (loudest, std::max (std::abs (left[i]), std::abs (right[i])));
        }
        // One writer (this thread); status exchanges it back to zero.
        if (loudest > peak.load (std::memory_order_relaxed))
            peak.store (loudest, std::memory_order_relaxed);
        at += (uint64_t) taken;
        if (taken < n)
        {
            underruns.fetch_add (1, std::memory_order_relaxed);
            primed = false;
        }
    }
    // Stored even while priming, so the writer sees what was skipped.
    header->read.store (at, std::memory_order_release);
#endif
    std::fill (left + taken, left + n, 0.0f);
    std::fill (right + taken, right + n, 0.0f);
}

juce::var RingInput::stats (bool consumePeak)
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("ring", (int) ringId);
#if ! defined(_WIN32)
    const auto* header = static_cast<const ring::Header*> (mapped);
    object->setProperty ("written", (juce::int64) header->written.load (std::memory_order_relaxed));
    object->setProperty ("read", (juce::int64) header->read.load (std::memory_order_relaxed));
    object->setProperty ("dropped", (juce::int64) header->dropped.load (std::memory_order_relaxed));
#endif
    object->setProperty ("underruns", (juce::int64) underruns.load (std::memory_order_relaxed));
    object->setProperty ("skipped", (juce::int64) skipped.load (std::memory_order_relaxed));
    object->setProperty ("peak", (double) (consumePeak ? peak.exchange (0.0f) : peak.load()));
    return juce::var (object);
}

std::string runRingFeed (uint32_t id, const std::string& wavPath)
{
#if defined(_WIN32)
    juce::ignoreUnused (id, wavPath);
    return "the ring needs POSIX shared memory";
#else
    try
    {
        const auto channels = dsp::readWav (wavPath).channels;
        const char* error = nullptr;
        auto mapping = ring::open (id, error);
        if (mapping.header == nullptr)
            return std::string ("ring ") + std::to_string (id) + ": " + error;
        const auto& left = channels[0];
        const auto& right = channels.size() > 1 ? channels[1] : channels[0];
        const auto burst = std::chrono::microseconds ((long long) (128.0 * 1e6 / mapping.header->sampleRate));
        auto due = std::chrono::steady_clock::now();
        for (size_t at = 0; at < left.size(); at += 128)
        {
            const int n = (int) std::min<size_t> (128, left.size() - at);
            ring::write (mapping.header, left.data() + at, right.data() + at, n);
            due += burst;
            std::this_thread::sleep_until (due);
        }
        ring::unmap (mapping);
        return {};
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
#endif
}

std::string runRingSelfTest()
{
#if defined(_WIN32)
    return "the ring needs POSIX shared memory";
#else
    struct Writer
    {
        explicit Writer (uint32_t id)
        {
            const char* error = nullptr;
            mapping = ring::open (id, error);
            if (mapping.header == nullptr)
                throw std::runtime_error (std::string ("the writer could not open the ring: ") + error);
        }
        ~Writer() { ring::unmap (mapping); }
        // A burst of the frames that come next: left counts up from 0 and
        // right is its negation, so a reader can tell any gap or repeat.
        void burst (int n)
        {
            float left[512], right[512];
            for (int i = 0; i < n; ++i)
            {
                left[i] = (float) (next + (uint64_t) i);
                right[i] = -left[i];
            }
            next += (uint64_t) ring::write (mapping.header, left, right, n);
        }
        ring::Mapping mapping;
        uint64_t next = 0;
    };
    // The reader's left channel, call after call, and whether every value
    // that is not silence follows the one before it, allowing a jump
    // forward only where `skipsAllowed`.
    struct Reader
    {
        explicit Reader (RingInput& input) : input (input) {}
        void block()
        {
            float left[512], right[512];
            input.read (left, right, 512);
            for (int i = 0; i < 512; ++i)
            {
                if (right[i] != -left[i])
                    mirrored = false;
                if (left[i] == 0.0f && right[i] == 0.0f && ! started)
                    continue;
                if (left[i] == 0.0f && started)
                {
                    ++silent;
                    continue;
                }
                if (started && left[i] != last + 1.0f)
                {
                    if (left[i] < last)
                        backwards = true;
                    ++jumps;
                }
                started = true;
                last = left[i];
                ++heard;
            }
        }
        RingInput& input;
        bool started = false, mirrored = true, backwards = false;
        float last = -1.0f;
        uint64_t heard = 0, silent = 0, jumps = 0;
    };
    const auto check = [] (bool holds, const std::string& what) -> std::string { return holds ? "" : what; };

    try
    {
        {
            // Steady: four 128-frame bursts a 512-frame block. After it
            // primes, every frame plays once, in order.
            RingInput input (48000);
            Writer writer (input.id());
            Reader reader (input);
            for (int cycle = 0; cycle < 200; ++cycle)
            {
                for (int b = 0; b < 4; ++b)
                    writer.burst (128);
                reader.block();
            }
            if (auto e = check (reader.jumps == 0 && reader.silent == 0 && reader.mirrored && reader.heard > 0,
                                "steady: the reader skipped, repeated, or fell silent");
                ! e.empty())
                return e;
        }
        {
            // A writer that stops for three blocks: the reader plays what
            // it holds, runs dry once, waits to fill, and goes on from the
            // frame after the last it played.
            RingInput input (48000);
            Writer writer (input.id());
            Reader reader (input);
            for (int cycle = 0; cycle < 60; ++cycle)
            {
                if (cycle < 20 || cycle >= 23)
                    for (int b = 0; b < 4; ++b)
                        writer.burst (128);
                reader.block();
            }
            const auto stats = input.stats();
            if (auto e = check ((juce::int64) stats["underruns"] == 1 && reader.jumps == 0 && reader.silent > 0
                                    && ! reader.backwards,
                                "underrun: the reader lost or repeated frames across the gap");
                ! e.empty())
                return e;
        }
        {
            // A writer a burst fast every block: the ring creeps up, the
            // reader drops the oldest excess, and never runs dry.
            RingInput input (48000);
            Writer writer (input.id());
            Reader reader (input);
            for (int cycle = 0; cycle < 200; ++cycle)
            {
                for (int b = 0; b < 5; ++b)
                    writer.burst (128);
                reader.block();
            }
            const auto stats = input.stats();
            if (auto e = check ((juce::int64) stats["skipped"] > 0 && (juce::int64) stats["underruns"] == 0
                                    && reader.silent == 0 && ! reader.backwards,
                                "drift: the reader did not hold the ring level");
                ! e.empty())
                return e;
        }
        {
            // Nothing reading: the ring fills and the rest counts as
            // dropped, not overwritten.
            RingInput input (48000);
            Writer writer (input.id());
            for (int b = 0; b < 80; ++b)
                writer.burst (128);
            const auto stats = input.stats();
            if (auto e = check ((juce::int64) stats["written"] == 8192 && (juce::int64) stats["dropped"] == 80 * 128 - 8192,
                                "overflow: the writer overwrote or lost count");
                ! e.empty())
                return e;
        }
    }
    catch (const std::exception& e)
    {
        return e.what();
    }
    return {};
#endif
}

} // namespace field
