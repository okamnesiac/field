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


// Opens `file`, cuts it to `bytes`, hands it to `patch`, and syncs it. A
// crash can leave a partial frame or line at the end; the file should end
// where its last whole one does.
template <typename Patch>
void truncateAndSync (const juce::File& file, juce::int64 bytes, Patch&& patch)
{
    std::FILE* f = std::fopen (file.getFullPathName().toRawUTF8(), "r+b");
    if (f == nullptr)
        throw std::runtime_error ("cannot open " + file.getFullPathName().toStdString());
    if (truncateTo (f, bytes) != 0)
    {
        std::fclose (f);
        throw std::runtime_error ("cannot truncate " + file.getFullPathName().toStdString());
    }
    patch (f);
    std::fflush (f);
    syncToDisk (f);
    std::fclose (f);
}

constexpr const char* wavName = "take.wav";
constexpr const char* midiName = "take.midi.ndjson";
constexpr int midiFifoCapacity = 1 << 14; // messages; the writer wakes every 20 ms

bool isMidiTransaction (const juce::File& dir, const juce::var& manifest)
{
    return manifest.getProperty ("kind", juce::var()).toString() == "midi"
           || dir.getChildFile (midiName).existsAsFile();
}

// The whole lines a MIDI take's file holds, where the last of them ends,
// and the `at` it carries (-1 with no lines).
struct MidiOnDisk
{
    juce::int64 events = 0;
    juce::int64 bytes = 0;
    juce::int64 lastAt = -1;
};

MidiOnDisk midiOnDisk (const juce::File& file)
{
    MidiOnDisk result;
    juce::MemoryBlock block;
    if (! file.loadFileAsData (block))
        return result;
    const auto* text = static_cast<const char*> (block.getData());
    juce::int64 lastLine = 0;
    for (juce::int64 i = 0; i < (juce::int64) block.getSize(); ++i)
        if (text[i] == '\n')
        {
            lastLine = result.bytes;
            result.bytes = i + 1;
            ++result.events;
        }
    if (result.events > 0)
        result.lastAt = (juce::int64) juce::JSON::parse (
                            juce::String::fromUTF8 (text + lastLine, (int) (result.bytes - 1 - lastLine)))
                            .getProperty ("at", -1);
    return result;
}
} // namespace

Transaction::Transaction (const juce::File& root, const Facts& f, const char* name)
    : facts (f), dataName (name)
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

    const auto path = dir.getChildFile (dataName);
    data = std::fopen (path.getFullPathName().toRawUTF8(), "wb");
    if (data == nullptr)
        throw std::runtime_error ("cannot open " + path.getFullPathName().toStdString());
}

Transaction::~Transaction()
{
    joinWriter();
    // Not finalized: whatever the writer drained stays on disk, the WAV
    // header unpatched, which is exactly what recover() expects.
    closeData();
}

void Transaction::begin()
{
    writeManifest (false);
    writeJournal();
    writer = std::thread ([this] { writerLoop(); });
}

void Transaction::joinWriter()
{
    stopWriter = true;
    wake.signal();
    if (writer.joinable())
        writer.join();
}

void Transaction::syncData()
{
    std::fflush (data);
    syncToDisk (data);
}

void Transaction::closeData()
{
    if (data == nullptr)
        return;
    std::fflush (data);
    std::fclose (data);
    data = nullptr;
}

void Transaction::setStartedAt (juce::int64 positionSamples) noexcept
{
    startedAtSamples.store (positionSamples);
}

void Transaction::discard()
{
    joinWriter();
    closeData();
    finalized = true; // nothing left to finalize
    dir.deleteRecursively();
}

void Transaction::writerLoop()
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
            writeManifest (false);
        }
        const auto now = juce::Time::getMillisecondCounterHiRes();
        if (now - lastJournal >= journalEverySeconds * 1000.0)
        {
            lastJournal = now;
            syncData();
            writeJournal();
        }
    }
}

void Transaction::writeJournal()
{
    // What fsync has reached the disk with: the floor a recovery after
    // power loss can trust. A process crash keeps more (everything the
    // kernel accepted), and recover() reads the file for that.
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    describeJournal (*o);
    o->setProperty ("flushed_at", juce::Time::getCurrentTime().toISO8601 (true));
    writeJson (dir.getChildFile ("journal.json"), juce::var (o.get()));
}

void Transaction::writeManifest (bool complete)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty ("id", transactionId);
    o->setProperty ("file", file());
    o->setProperty ("track", facts.track);
    if (facts.song.isNotEmpty())
        o->setProperty ("song", facts.song);
    if (facts.source.isNotEmpty())
        o->setProperty ("source", facts.source);
    describeFacts (*o);
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
        describeCounts (*o);
    writeJson (dir.getChildFile ("manifest.json"), juce::var (o.get()));
    if (complete)
        finalManifest = juce::var (o.get());
}

juce::var Transaction::finalize()
{
    if (finalized)
        return finalManifest;
    finalized = true;
    joinWriter();
    drain();
    completeData();
    syncData();
    closeData();
    writeJournal();
    writeManifest (true);
    return finalManifest;
}

juce::var Transaction::list (const juce::File& root, const juce::String& activeId)
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
        // frames or messages are what recover() would keep.
        const bool midi = isMidiTransaction (d, manifest);
        if (midi)
        {
            o->setProperty ("frames_on_disk", 0);
            o->setProperty ("events_on_disk", midiOnDisk (d.getChildFile (midiName)).events);
        }
        else
            o->setProperty ("frames_on_disk", framesOnDisk (d.getChildFile (wavName)));
        if (! o->hasProperty ("file"))
            o->setProperty ("file", ".field/recording/" + id + "/" + (midi ? midiName : wavName));
        entries.add (juce::var (o.get()));
    }
    return juce::var (entries);
}

juce::var Transaction::recover (const juce::File& root, const juce::String& id)
{
    const auto d = recordingRoot (root).getChildFile (id);
    if (id.isEmpty() || id.containsAnyOf ("/\\") || ! d.isDirectory())
        throw std::runtime_error ("no recording transaction " + id.toStdString());
    auto manifest = readManifest (d);
    if ((bool) manifest.getProperty ("complete", false))
        throw std::runtime_error (id.toStdString() + " is already complete");
    const bool midi = isMidiTransaction (d, manifest);
    const auto dataFile = d.getChildFile (midi ? midiName : wavName);
    if (! dataFile.existsAsFile())
        throw std::runtime_error (id.toStdString() + " has no " + dataFile.getFileName().toStdString()
                                  + " to recover");
    const auto journal = juce::JSON::parse (d.getChildFile ("journal.json"));

    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    if (auto* m = manifest.getDynamicObject())
        for (auto& prop : m->getProperties())
            o->setProperty (prop.name, prop.value);
    o->setProperty ("id", id);
    if (! o->hasProperty ("file"))
        o->setProperty ("file", ".field/recording/" + id + "/" + dataFile.getFileName());
    o->setProperty ("complete", true);
    o->setProperty ("recovered", true);
    // The journal's counts are the fsync floor; what is kept is what the
    // kernel had, which after a process crash is more. Both stay visible
    // so the difference is a fact rather than a mystery.
    if (midi)
    {
        const auto onDisk = midiOnDisk (dataFile);
        truncateAndSync (dataFile, onDisk.bytes, [] (std::FILE*) {});
        // The elapsed samples reach the journal once a second; a message
        // written after the last journal shows the take ran at least to it.
        const auto journaledFrames = (juce::int64) journal.getProperty ("frames", 0);
        o->setProperty ("frames", std::max (journaledFrames, onDisk.lastAt + 1));
        o->setProperty ("events", onDisk.events);
        o->setProperty ("journaled_frames", journaledFrames);
        o->setProperty ("journaled_events", journal.getProperty ("events", 0));
    }
    else
    {
        const auto frames = framesOnDisk (dataFile);
        truncateAndSync (dataFile, headerBytes + frames * 4, [frames] (std::FILE* f) { patchHeader (f, frames); });
        o->setProperty ("frames", frames);
        o->setProperty ("journaled_frames", journal.getProperty ("frames", 0));
    }
    if (! o->hasProperty ("dropped"))
        o->setProperty ("dropped", journal.getProperty ("dropped", 0));
    writeJson (d.getChildFile ("manifest.json"), juce::var (o.get()));
    return juce::var (o.get());
}

Capture::Capture (const juce::File& root, const Facts& f)
    : Transaction (root, f, wavName), fifo (fifoCapacity), ring ((size_t) fifoCapacity), scratch ((size_t) fifoCapacity)
{
    writeHeader (data, facts.sampleRate);
    std::fflush (data);
    begin();
}

Capture::~Capture()
{
    joinWriter();
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
    if (std::fwrite (scratch.data(), sizeof (float), frames, data) == frames)
        writtenFrames.fetch_add ((juce::int64) frames);
}

void Capture::completeData()
{
    patchHeader (data, writtenFrames.load());
}

void Capture::describeProgress (juce::DynamicObject& record) const
{
    record.setProperty ("frames", pushed());
    record.setProperty ("written", written());
    record.setProperty ("dropped", dropped());
}

void Capture::describeFacts (juce::DynamicObject& manifest) const
{
    manifest.setProperty ("device", facts.device);
    manifest.setProperty ("input", facts.input);
    manifest.setProperty ("sample_rate", facts.sampleRate);
    if (facts.timelineRate > 0.0)
        manifest.setProperty ("timeline_rate", facts.timelineRate);
    manifest.setProperty ("channels", 1);
    manifest.setProperty ("bit_depth", 32);
    manifest.setProperty ("format", "float");
    manifest.setProperty ("input_latency", facts.inputLatency);
    manifest.setProperty ("output_latency", facts.outputLatency);
}

void Capture::describeCounts (juce::DynamicObject& manifest) const
{
    manifest.setProperty ("frames", writtenFrames.load());
    manifest.setProperty ("dropped", droppedFrames.load());
}

void Capture::describeJournal (juce::DynamicObject& journal) const
{
    journal.setProperty ("frames", writtenFrames.load());
    journal.setProperty ("dropped", droppedFrames.load());
}

MidiCapture::MidiCapture (const juce::File& root, const Facts& f)
    : Transaction (root, f, midiName), fifo (midiFifoCapacity), ring ((size_t) midiFifoCapacity)
{
    begin();
}

MidiCapture::~MidiCapture()
{
    joinWriter();
}

void MidiCapture::push (juce::int64 at, const juce::uint8* bytes, int size) noexcept
{
    int start1, size1, start2, size2;
    fifo.prepareToWrite (1, start1, size1, start2, size2);
    if (size1 + size2 == 0)
    {
        droppedEvents.fetch_add (1);
        return;
    }
    auto& event = ring[(size_t) (size1 > 0 ? start1 : start2)];
    event.at = at;
    event.size = juce::jlimit (0, maxMessageBytes, size);
    std::memcpy (event.bytes, bytes, (size_t) event.size);
    fifo.finishedWrite (1);
    pushedEvents.fetch_add (1);
}

void MidiCapture::drain()
{
    const int ready = fifo.getNumReady();
    if (ready <= 0)
        return;
    int start1, size1, start2, size2;
    fifo.prepareToRead (ready, start1, size1, start2, size2);
    lines.clear();
    const auto append = [this] (const Event& event)
    {
        lines += "{\"at\":" + std::to_string (event.at) + ",\"midi\":[";
        for (int i = 0; i < event.size; ++i)
            lines += (i > 0 ? "," : "") + std::to_string (event.bytes[i]);
        lines += "]}\n";
    };
    for (int i = 0; i < size1; ++i)
        append (ring[(size_t) (start1 + i)]);
    for (int i = 0; i < size2; ++i)
        append (ring[(size_t) (start2 + i)]);
    fifo.finishedRead (size1 + size2);
    if (std::fwrite (lines.data(), 1, lines.size(), data) == lines.size())
        writtenEvents.fetch_add (size1 + size2);
    // To the kernel now, not at the once-a-second sync, so a daemon that
    // dies loses at most a partial last line, as recover promises.
    std::fflush (data);
}

void MidiCapture::describeProgress (juce::DynamicObject& record) const
{
    record.setProperty ("frames", frames());
    record.setProperty ("events", events());
    record.setProperty ("dropped", dropped());
}

void MidiCapture::describeFacts (juce::DynamicObject& manifest) const
{
    manifest.setProperty ("kind", "midi");
    juce::Array<juce::var> sources;
    for (const auto& source : facts.sources)
        sources.add (source);
    manifest.setProperty ("sources", sources);
    manifest.setProperty ("sample_rate", facts.sampleRate);
    if (facts.timelineRate > 0.0)
        manifest.setProperty ("timeline_rate", facts.timelineRate);
    manifest.setProperty ("output_latency", facts.outputLatency);
}

void MidiCapture::describeCounts (juce::DynamicObject& manifest) const
{
    manifest.setProperty ("frames", elapsedFrames.load());
    manifest.setProperty ("events", writtenEvents.load());
    manifest.setProperty ("dropped", droppedEvents.load());
}

void MidiCapture::describeJournal (juce::DynamicObject& journal) const
{
    journal.setProperty ("frames", elapsedFrames.load());
    journal.setProperty ("events", writtenEvents.load());
    journal.setProperty ("dropped", droppedEvents.load());
}

} // namespace field
