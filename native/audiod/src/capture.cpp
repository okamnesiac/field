#include "capture.h"

#include <sys/stat.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace field
{
namespace
{
// The float32 layout wavfile.cpp's writeWavFloat32 emits — RIFF, an
// 18-byte fmt with cbSize, the fact chunk non-PCM requires, data — with
// mono fixed, because a take is one input (recording.md §3). 58 bytes.
constexpr long headerBytes = 58;
constexpr long factFramesAt = 46;
constexpr long dataSizeAt = 54;
constexpr int fifoCapacity = 1 << 20; // ~22 s at 48 kHz: the writer wakes every 20 ms
constexpr double journalEverySeconds = 1.0;

// The two calls crash safety rides on, spelled per platform: push a
// file's bytes to the device, and cut it to a length. MSVC's CRT has
// neither fsync nor ftruncate; _commit is FlushFileBuffers, and
// _chsize_s takes the 64-bit size a long take needs.
int syncToDisk (std::FILE* f)
{
#if defined(_WIN32)
    return _commit (_fileno (f));
#else
    return ::fsync (fileno (f));
#endif
}

int truncateTo (std::FILE* f, juce::int64 bytes)
{
#if defined(_WIN32)
    return _chsize_s (_fileno (f), bytes) == 0 ? 0 : -1;
#else
    return ::ftruncate (fileno (f), (off_t) bytes);
#endif
}

void putTag (uint8_t* at, const char* tag) { std::memcpy (at, tag, 4); }
void putU16 (uint8_t* at, uint16_t v)
{
    at[0] = (uint8_t) (v & 0xff);
    at[1] = (uint8_t) ((v >> 8) & 0xff);
}
void putU32 (uint8_t* at, uint32_t v)
{
    at[0] = (uint8_t) (v & 0xff);
    at[1] = (uint8_t) ((v >> 8) & 0xff);
    at[2] = (uint8_t) ((v >> 16) & 0xff);
    at[3] = (uint8_t) ((v >> 24) & 0xff);
}

// Sizes zero: the header of a transaction still being written. A
// reader that trusts the header sees no frames, which is the honest
// answer until finalize or recover patches it.
void writeHeader (std::FILE* f, double sampleRate)
{
    uint8_t h[headerBytes] = {};
    const auto rate = (uint32_t) sampleRate;
    putTag (h, "RIFF");
    putU32 (h + 4, 0);
    putTag (h + 8, "WAVE");
    putTag (h + 12, "fmt ");
    putU32 (h + 16, 18);
    putU16 (h + 20, 3); // IEEE float
    putU16 (h + 22, 1); // mono
    putU32 (h + 24, rate);
    putU32 (h + 28, rate * 4); // byte rate
    putU16 (h + 32, 4); // block align
    putU16 (h + 34, 32);
    putU16 (h + 36, 0); // cbSize
    putTag (h + 38, "fact");
    putU32 (h + 42, 4);
    putU32 (h + 46, 0);
    putTag (h + 50, "data");
    putU32 (h + 54, 0);
    if (std::fwrite (h, 1, headerBytes, f) != headerBytes)
        throw std::runtime_error ("cannot write the WAV header");
}

// Patch the three sizes in place. The RIFF size covers everything after
// its own field; both frame counts are the same number in different
// units. Frames beyond what fits in 32 bits (six hours of mono float at
// 48 kHz) would need RF64, which no take has earned yet.
void patchHeader (std::FILE* f, juce::int64 frames)
{
    const auto dataSize = (uint32_t) (frames * 4);
    uint8_t v[4];
    putU32 (v, (uint32_t) (headerBytes - 8) + dataSize);
    std::fseek (f, 4, SEEK_SET);
    std::fwrite (v, 1, 4, f);
    putU32 (v, (uint32_t) frames);
    std::fseek (f, factFramesAt, SEEK_SET);
    std::fwrite (v, 1, 4, f);
    putU32 (v, dataSize);
    std::fseek (f, dataSizeAt, SEEK_SET);
    std::fwrite (v, 1, 4, f);
    std::fseek (f, 0, SEEK_END);
}

// Whole frames the file holds past the header, however it got there.
juce::int64 framesOnDisk (const juce::File& wav)
{
    const auto size = wav.getSize();
    return size <= headerBytes ? 0 : (size - headerBytes) / 4;
}

juce::File recordingRoot (const juce::File& root)
{
    return root.getChildFile (".field").getChildFile ("recording");
}

juce::var readManifest (const juce::File& dir)
{
    return juce::JSON::parse (dir.getChildFile ("manifest.json"));
}

void writeJson (const juce::File& file, const juce::var& value)
{
    // replaceWithText writes a temporary and renames it over the target,
    // so a crash between the two leaves the previous version, never a
    // half-written one.
    if (! file.replaceWithText (juce::JSON::toString (value, true) + "\n"))
        throw std::runtime_error ("cannot write " + file.getFullPathName().toStdString());
}

juce::var syncAndPatch (const juce::File& wav, juce::int64 frames)
{
    std::FILE* f = std::fopen (wav.getFullPathName().toRawUTF8(), "r+b");
    if (f == nullptr)
        throw std::runtime_error ("cannot open " + wav.getFullPathName().toStdString());
    // A crash can leave a partial frame at the end; the header will say
    // `frames`, and the file should end where the header says.
    if (truncateTo (f, headerBytes + frames * 4) != 0)
    {
        std::fclose (f);
        throw std::runtime_error ("cannot truncate " + wav.getFullPathName().toStdString());
    }
    patchHeader (f, frames);
    std::fflush (f);
    syncToDisk (f);
    std::fclose (f);
    return {};
}
} // namespace

Capture::Capture (const juce::File& root, const Facts& f)
    : facts (f), fifo (fifoCapacity), ring ((size_t) fifoCapacity), scratch ((size_t) fifoCapacity)
{
    // Timestamp names (recording.md §3): sortable, and two clones
    // recording independently cannot mint the same one. A second take in
    // the same second on one machine gets a suffix rather than a clash.
    const auto now = juce::Time::getCurrentTime();
    const auto stamp = "take-" + now.formatted ("%Y%m%d-%H%M%S");
    startedWall = now.toISO8601 (true);
    const auto parent = recordingRoot (root);
    if (! parent.createDirectory())
        throw std::runtime_error ("cannot create " + parent.getFullPathName().toStdString());
    transactionId = stamp;
    for (int n = 2; parent.getChildFile (transactionId).exists(); ++n)
        transactionId = stamp + "-" + juce::String (n);
    dir = parent.getChildFile (transactionId);
    if (! dir.createDirectory())
        throw std::runtime_error ("cannot create " + dir.getFullPathName().toStdString());

    const auto wavPath = dir.getChildFile ("take.wav");
    wav = std::fopen (wavPath.getFullPathName().toRawUTF8(), "wb");
    if (wav == nullptr)
        throw std::runtime_error ("cannot open " + wavPath.getFullPathName().toStdString());
    writeHeader (wav, facts.sampleRate);
    std::fflush (wav);
    writeManifest (false, false);
    writeJournal();

    writer = std::thread ([this] { writerLoop(); });
}

Capture::~Capture()
{
    stopWriter = true;
    wake.signal();
    if (writer.joinable())
        writer.join();
    if (wav != nullptr)
    {
        // Not finalized: whatever the writer drained stays on disk under
        // an unpatched header, which is exactly what recover() expects.
        std::fflush (wav);
        std::fclose (wav);
        wav = nullptr;
    }
}

void Capture::setStartedAt (juce::int64 positionSamples) noexcept
{
    startedAtSamples.store (positionSamples);
}

void Capture::push (const float* samples, int n) noexcept
{
    int start1, size1, start2, size2;
    fifo.prepareToWrite (n, start1, size1, start2, size2);
    if (size1 > 0)
        std::memcpy (ring.data() + start1, samples, (size_t) size1 * sizeof (float));
    if (size2 > 0)
        std::memcpy (ring.data() + start2, samples + size1, (size_t) size2 * sizeof (float));
    fifo.finishedWrite (size1 + size2);
    pushedFrames.fetch_add (size1 + size2);
    // The writer fell more than the FIFO behind: those frames are gone,
    // and the manifest says how many, so the take is never silently
    // shorter than the performance.
    if (size1 + size2 < n)
        droppedFrames.fetch_add (n - (size1 + size2));
}

void Capture::drain()
{
    const int ready = fifo.getNumReady();
    if (ready <= 0)
        return;
    int start1, size1, start2, size2;
    fifo.prepareToRead (ready, start1, size1, start2, size2);
    if (size1 > 0)
        std::memcpy (scratch.data(), ring.data() + start1, (size_t) size1 * sizeof (float));
    if (size2 > 0)
        std::memcpy (scratch.data() + size1, ring.data() + start2, (size_t) size2 * sizeof (float));
    fifo.finishedRead (size1 + size2);
    const auto frames = (size_t) (size1 + size2);
    // Little-endian float32 straight from memory — the assumption
    // wavfile.h states for both supported platforms.
    if (std::fwrite (scratch.data(), sizeof (float), frames, wav) == frames)
        writtenFrames.fetch_add ((juce::int64) frames);
}

void Capture::discard()
{
    stopWriter = true;
    wake.signal();
    if (writer.joinable())
        writer.join();
    if (wav != nullptr)
    {
        std::fclose (wav);
        wav = nullptr;
    }
    finalized = true; // nothing left to finalize
    dir.deleteRecursively();
}

void Capture::writerLoop()
{
    auto lastJournal = juce::Time::getMillisecondCounterHiRes();
    while (! stopWriter.load())
    {
        wake.wait (20);
        drain();
        // The start position is latched by the callback on the first
        // block; the manifest on disk learns it from here, off the audio
        // thread, so a crash in the first second still leaves a
        // placeable take. A standby opened ahead of its take (a loop's
        // next pass) started when it latched, not when it was opened, so
        // the wall time follows the latch.
        if (! manifestHasStart && startedAtSamples.load() >= 0)
        {
            startedWall = juce::Time::getCurrentTime().toISO8601 (true);
            writeManifest (false, false);
        }
        const auto now = juce::Time::getMillisecondCounterHiRes();
        if (now - lastJournal >= journalEverySeconds * 1000.0)
        {
            lastJournal = now;
            std::fflush (wav);
            syncToDisk (wav);
            writeJournal();
        }
    }
}

void Capture::writeJournal()
{
    // What fsync has reached the disk with: the floor a recovery after
    // power loss can trust. A process crash keeps more (everything the
    // kernel accepted), and recover() reads the file for that.
    journaledFrames = writtenFrames.load();
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty ("frames", journaledFrames);
    o->setProperty ("dropped", droppedFrames.load());
    o->setProperty ("flushed_at", juce::Time::getCurrentTime().toISO8601 (true));
    writeJson (dir.getChildFile ("journal.json"), juce::var (o.get()));
}

void Capture::writeManifest (bool complete, bool recovered)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty ("id", transactionId);
    o->setProperty ("file", ".field/recording/" + transactionId + "/take.wav");
    o->setProperty ("track", facts.track);
    if (facts.song.isNotEmpty())
        o->setProperty ("song", facts.song);
    if (facts.source.isNotEmpty())
        o->setProperty ("source", facts.source);
    o->setProperty ("device", facts.device);
    o->setProperty ("input", facts.input);
    o->setProperty ("sample_rate", facts.sampleRate);
    if (facts.timelineRate > 0.0)
        o->setProperty ("timeline_rate", facts.timelineRate);
    o->setProperty ("channels", 1);
    o->setProperty ("bit_depth", 32);
    o->setProperty ("format", "float");
    o->setProperty ("input_latency", facts.inputLatency);
    o->setProperty ("output_latency", facts.outputLatency);
    const auto startedAt = startedAtSamples.load();
    if (startedAt >= 0)
    {
        o->setProperty ("started_at_samples", startedAt);
        manifestHasStart = true;
    }
    o->setProperty ("started_wall", startedWall);
    o->setProperty ("daemon", facts.daemonVersion);
    o->setProperty ("complete", complete);
    if (complete)
    {
        o->setProperty ("frames", writtenFrames.load());
        o->setProperty ("dropped", droppedFrames.load());
    }
    if (recovered)
        o->setProperty ("recovered", true);
    writeJson (dir.getChildFile ("manifest.json"), juce::var (o.get()));
    if (complete)
        finalManifest = juce::var (o.get());
}

juce::var Capture::finalize()
{
    if (finalized)
        return finalManifest;
    finalized = true;
    stopWriter = true;
    wake.signal();
    if (writer.joinable())
        writer.join();
    drain();
    patchHeader (wav, writtenFrames.load());
    std::fflush (wav);
    syncToDisk (wav);
    std::fclose (wav);
    wav = nullptr;
    writeJournal();
    writeManifest (true, false);
    return finalManifest;
}

juce::var Capture::list (const juce::File& root, const juce::String& activeId)
{
    juce::Array<juce::var> entries;
    auto dirs = recordingRoot (root).findChildFiles (juce::File::findDirectories, false);
    dirs.sort();
    for (const auto& d : dirs)
    {
        auto manifest = readManifest (d);
        juce::DynamicObject::Ptr o = new juce::DynamicObject();
        if (auto* m = manifest.getDynamicObject())
            for (auto& prop : m->getProperties())
                o->setProperty (prop.name, prop.value);
        const auto id = d.getFileName();
        o->setProperty ("id", id);
        o->setProperty ("active", id == activeId);
        const bool complete = (bool) manifest.getProperty ("complete", false);
        o->setProperty ("complete", complete);
        // On disk, not in the manifest: an incomplete transaction's
        // frames are what recover() would keep.
        o->setProperty ("frames_on_disk", framesOnDisk (d.getChildFile ("take.wav")));
        if (! o->hasProperty ("file"))
            o->setProperty ("file", ".field/recording/" + id + "/take.wav");
        entries.add (juce::var (o.get()));
    }
    return juce::var (entries);
}

juce::var Capture::recover (const juce::File& root, const juce::String& id)
{
    const auto d = recordingRoot (root).getChildFile (id);
    if (id.isEmpty() || id.containsAnyOf ("/\\") || ! d.isDirectory())
        throw std::runtime_error ("no recording transaction " + id.toStdString());
    auto manifest = readManifest (d);
    if ((bool) manifest.getProperty ("complete", false))
        throw std::runtime_error (id.toStdString() + " is already complete");
    const auto wav = d.getChildFile ("take.wav");
    if (! wav.existsAsFile())
        throw std::runtime_error (id.toStdString() + " has no take.wav to recover");
    const auto frames = framesOnDisk (wav);
    syncAndPatch (wav, frames);

    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    if (auto* m = manifest.getDynamicObject())
        for (auto& prop : m->getProperties())
            o->setProperty (prop.name, prop.value);
    o->setProperty ("id", id);
    if (! o->hasProperty ("file"))
        o->setProperty ("file", ".field/recording/" + id + "/take.wav");
    o->setProperty ("complete", true);
    o->setProperty ("recovered", true);
    o->setProperty ("frames", frames);
    // The journal's count is the fsync floor; the frames kept are what
    // the kernel had, which after a process crash is more. Both stay
    // visible so the difference is a fact rather than a mystery.
    const auto journal = juce::JSON::parse (d.getChildFile ("journal.json"));
    o->setProperty ("journaled_frames", journal.getProperty ("frames", 0));
    if (! o->hasProperty ("dropped"))
        o->setProperty ("dropped", journal.getProperty ("dropped", 0));
    writeJson (d.getChildFile ("manifest.json"), juce::var (o.get()));
    return juce::var (o.get());
}

} // namespace field
