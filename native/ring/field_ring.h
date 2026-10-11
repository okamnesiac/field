#pragma once

// The audio ring between FieldOut, a UGen in the voice host's scsynth,
// and field-audiod (live-supercollider.md §2): one POSIX shared-memory
// object holding this header and an interleaved stereo float ring, with
// a single producer, FieldOut on scsynth's audio thread, and a single
// consumer, the daemon's audio callback. The daemon creates and owns the
// object; FieldOut opens it by number.
//
// This header is MIT like the rest of Field. native/sc-fieldout, which is
// GPL-3.0 (§11), includes it so both sides agree on the layout; nothing
// links across that line. The writer's code lives here, not in the
// plugin, so the daemon's self-test runs the same lines FieldOut does.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>

#if ! defined(_WIN32)
    #include <fcntl.h>
    #include <sys/mman.h>
    #include <sys/stat.h>
    #include <unistd.h>
#endif

namespace field::ring
{
constexpr uint32_t magic = 0x52444c46; // "FLDR", little-endian
constexpr uint32_t version = 1;
constexpr uint32_t channels = 2;
// FieldOut takes the ring's number as a UGen input, and every UGen input
// is a float, which carries an integer exactly only below 2^24.
constexpr uint32_t maxId = 1u << 24;

static_assert (std::atomic<uint64_t>::is_always_lock_free,
               "the ring's counters must be lock-free to be shared between processes");

struct Header
{
    uint32_t magic;
    uint32_t version;
    uint32_t channels;
    uint32_t capacity; // frames, a power of two
    uint32_t sampleRate; // the daemon's device rate when the ring was made
    uint32_t reserved;
    // Frames ever written and read. Each side stores only its own, and
    // the difference is what the ring holds.
    std::atomic<uint64_t> written;
    std::atomic<uint64_t> read;
    // Frames the writer could not fit, because nothing was reading.
    std::atomic<uint64_t> dropped;
};

constexpr size_t dataOffset = 64; // the header, rounded up to a cache line
static_assert (sizeof (Header) <= dataOffset, "the header must fit before the data");

inline size_t bytesFor (uint32_t capacity)
{
    return dataOffset + (size_t) capacity * channels * sizeof (float);
}

inline float* data (Header* header)
{
    return reinterpret_cast<float*> (reinterpret_cast<char*> (header) + dataOffset);
}

// The shared-memory name for ring `id`, into a caller's buffer so the
// audio thread never allocates for it. Short, because macOS caps a POSIX
// shared-memory name at 31 characters.
inline void nameFor (uint32_t id, char (&name)[32])
{
    std::snprintf (name, sizeof name, "/field-ring-%u", id);
}

// Append up to n frames; what does not fit is counted as dropped rather
// than overwriting what the reader has not taken. Returns the frames
// written. Single producer only.
inline int write (Header* header, const float* left, const float* right, int n)
{
    const uint64_t written = header->written.load (std::memory_order_relaxed);
    const uint64_t read = header->read.load (std::memory_order_acquire);
    const uint64_t room = header->capacity - (written - read);
    const int fit = (int) (room < (uint64_t) n ? room : (uint64_t) n);
    float* frames = data (header);
    const uint64_t mask = header->capacity - 1;
    for (int i = 0; i < fit; ++i)
    {
        const size_t at = (size_t) ((written + (uint64_t) i) & mask) * channels;
        frames[at] = left[i];
        frames[at + 1] = right[i];
    }
    header->written.store (written + (uint64_t) fit, std::memory_order_release);
    if (fit < n)
        header->dropped.fetch_add ((uint64_t) (n - fit), std::memory_order_relaxed);
    return fit;
}

#if ! defined(_WIN32)
// A writer's view of ring `id`: mapped, or null with the reason in
// `error` when the ring does not exist or is not one this layout reads.
struct Mapping
{
    Header* header = nullptr;
    size_t bytes = 0;
};

inline Mapping open (uint32_t id, const char*& error)
{
    char name[32];
    nameFor (id, name);
    Mapping mapping;
    const int fd = shm_open (name, O_RDWR, 0);
    if (fd < 0)
    {
        error = "no such ring";
        return mapping;
    }
    struct stat info;
    if (fstat (fd, &info) != 0 || (size_t) info.st_size < dataOffset)
    {
        ::close (fd);
        error = "the ring is too small to hold its header";
        return mapping;
    }
    void* mapped = mmap (nullptr, (size_t) info.st_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    ::close (fd);
    if (mapped == MAP_FAILED)
    {
        error = "the ring would not map";
        return mapping;
    }
    auto* header = static_cast<Header*> (mapped);
    const bool valid = header->magic == magic && header->version == version && header->channels == channels
                       && header->capacity > 0 && (header->capacity & (header->capacity - 1)) == 0
                       && bytesFor (header->capacity) <= (size_t) info.st_size;
    if (! valid)
    {
        munmap (mapped, (size_t) info.st_size);
        error = "the ring's layout is not this version's";
        return mapping;
    }
    mapping.header = header;
    mapping.bytes = (size_t) info.st_size;
    return mapping;
}

inline void unmap (Mapping& mapping)
{
    if (mapping.header != nullptr)
        munmap (mapping.header, mapping.bytes);
    mapping = {};
}
#endif

} // namespace field::ring
