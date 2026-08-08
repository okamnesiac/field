#include "wavfile.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>

namespace field::dsp
{
namespace
{
constexpr uint16_t formatPcm = 1;
constexpr uint16_t formatFloat = 3;
constexpr uint16_t formatExtensible = 0xfffe;

uint16_t readU16 (const std::vector<uint8_t>& buf, size_t at)
{
    return (uint16_t) ((uint16_t) buf[at] | ((uint16_t) buf[at + 1] << 8));
}

uint32_t readU32 (const std::vector<uint8_t>& buf, size_t at)
{
    return (uint32_t) buf[at] | ((uint32_t) buf[at + 1] << 8) | ((uint32_t) buf[at + 2] << 16)
           | ((uint32_t) buf[at + 3] << 24);
}

bool tagIs (const std::vector<uint8_t>& buf, size_t at, const char* tag)
{
    return std::memcmp (buf.data() + at, tag, 4) == 0;
}

void putTag (std::vector<uint8_t>& buf, size_t at, const char* tag)
{
    std::memcpy (buf.data() + at, tag, 4);
}

void putU16 (std::vector<uint8_t>& buf, size_t at, uint16_t v)
{
    buf[at] = (uint8_t) (v & 0xff);
    buf[at + 1] = (uint8_t) ((v >> 8) & 0xff);
}

void putU32 (std::vector<uint8_t>& buf, size_t at, uint32_t v)
{
    buf[at] = (uint8_t) (v & 0xff);
    buf[at + 1] = (uint8_t) ((v >> 8) & 0xff);
    buf[at + 2] = (uint8_t) ((v >> 16) & 0xff);
    buf[at + 3] = (uint8_t) ((v >> 24) & 0xff);
}
} // namespace

WavData readWav (const std::string& path)
{
    std::ifstream in (path, std::ios::binary);
    if (! in)
        throw std::runtime_error (path + ": cannot open");
    std::vector<uint8_t> buf ((std::istreambuf_iterator<char> (in)),
                              std::istreambuf_iterator<char>());

    if (buf.size() < 12 || ! tagIs (buf, 0, "RIFF") || ! tagIs (buf, 8, "WAVE"))
        throw std::runtime_error (path + ": not a RIFF/WAVE file");

    bool haveFmt = false;
    uint16_t format = 0, numChannels = 0, bits = 0;
    uint32_t sampleRate = 0;
    size_t dataAt = 0, dataSize = 0;
    bool haveData = false;

    size_t offset = 12;
    while (offset + 8 <= buf.size())
    {
        const uint32_t size = readU32 (buf, offset + 4);
        const size_t body = offset + 8;
        if (tagIs (buf, offset, "fmt ") && size >= 16 && body + size <= buf.size())
        {
            format = readU16 (buf, body);
            if (format == formatExtensible)
            {
                if (size < 40)
                    throw std::runtime_error (path + ": truncated extensible fmt chunk");
                // The real format tag is the first two bytes of the SubFormat GUID.
                format = readU16 (buf, body + 24);
            }
            numChannels = readU16 (buf, body + 2);
            sampleRate = readU32 (buf, body + 4);
            bits = readU16 (buf, body + 14);
            haveFmt = true;
        }
        else if (tagIs (buf, offset, "data"))
        {
            dataAt = body;
            dataSize = std::min ((size_t) size, buf.size() > body ? buf.size() - body : 0);
            haveData = true;
        }
        offset = body + size + (size % 2); // chunks are word-aligned
    }

    if (! haveFmt)
        throw std::runtime_error (path + ": no fmt chunk");
    if (! haveData)
        throw std::runtime_error (path + ": no data chunk");
    if (numChannels < 1)
        throw std::runtime_error (path + ": fmt declares no channels");

    const bool isFloat = format == formatFloat && bits == 32;
    const bool isPcm = format == formatPcm && (bits == 16 || bits == 24 || bits == 32);
    if (! isFloat && ! isPcm)
        throw std::runtime_error (path
                                  + ": unsupported WAV encoding — supported: 16/24/32-bit PCM "
                                    "and 32-bit float");

    const size_t bytesPerSample = bits / 8u;
    const size_t frames = dataSize / (bytesPerSample * numChannels);

    WavData result;
    result.sampleRate = (double) sampleRate;
    result.channels.assign (numChannels, std::vector<float> (frames, 0.0f));

    for (size_t frame = 0; frame < frames; ++frame)
    {
        const size_t base = dataAt + frame * numChannels * bytesPerSample;
        for (uint16_t ch = 0; ch < numChannels; ++ch)
        {
            const size_t at = base + ch * bytesPerSample;
            double value = 0.0;
            if (isFloat)
            {
                uint32_t raw = readU32 (buf, at);
                float f;
                std::memcpy (&f, &raw, sizeof (f));
                value = (double) f;
            }
            else if (bits == 16)
            {
                value = (double) (int16_t) readU16 (buf, at) / 32768.0;
            }
            else if (bits == 24)
            {
                int32_t raw = (int32_t) ((uint32_t) buf[at] | ((uint32_t) buf[at + 1] << 8)
                                         | ((uint32_t) buf[at + 2] << 16));
                if (raw & 0x800000)
                    raw -= 0x1000000;
                value = (double) raw / 8388608.0;
            }
            else
            {
                value = (double) (int32_t) readU32 (buf, at) / 2147483648.0;
            }
            result.channels[ch][frame] = (float) value;
        }
    }

    return result;
}

// Integer PCM out, for `normalize`'s 16- and 24-bit targets. A plain
// 16-byte fmt chunk with no fact chunk, which is what PCM wants and what
// the reader above already accepts.
//
// Samples are expected to sit on the quantization grid already —
// dsp::ditherTo puts them there — so the scale-and-round here is exact
// rather than a second, undithered quantization. Rounding anyway (not
// truncating) means a sample that arrives slightly off-grid lands on the
// nearest step instead of drifting a whole LSB toward zero.
void writeWavInt (const std::string& path,
                  double sampleRate,
                  const std::vector<std::vector<float>>& channels,
                  int bitDepth)
{
    if (channels.empty())
        throw std::runtime_error ("writeWavInt needs at least one channel");
    if (bitDepth != 16 && bitDepth != 24)
        throw std::runtime_error ("writeWavInt: unsupported bit depth "
                                  + std::to_string (bitDepth));
    const size_t frames = channels[0].size();
    for (const auto& channel : channels)
        if (channel.size() != frames)
            throw std::runtime_error ("writeWavInt channels must have equal lengths");

    const uint16_t count = (uint16_t) channels.size();
    const uint32_t rate = (uint32_t) sampleRate;
    const size_t width = (size_t) bitDepth / 8u;
    const size_t dataSize = frames * count * width;

    std::vector<uint8_t> buf (12 + 8 + 16 + 8 + dataSize, 0);
    size_t at = 0;
    putTag (buf, at, "RIFF");
    putU32 (buf, at + 4, (uint32_t) (buf.size() - 8));
    putTag (buf, at + 8, "WAVE");
    at += 12;
    putTag (buf, at, "fmt ");
    putU32 (buf, at + 4, 16);
    putU16 (buf, at + 8, formatPcm);
    putU16 (buf, at + 10, count);
    putU32 (buf, at + 12, rate);
    putU32 (buf, at + 16, (uint32_t) (rate * count * width)); // byte rate
    putU16 (buf, at + 20, (uint16_t) (count * width)); // block align
    putU16 (buf, at + 22, (uint16_t) bitDepth);
    at += 8 + 16;
    putTag (buf, at, "data");
    putU32 (buf, at + 4, (uint32_t) dataSize);
    at += 8;

    const double scale = std::pow (2.0, (double) (bitDepth - 1));
    const double low = -scale;
    const double high = scale - 1.0;

    for (size_t frame = 0; frame < frames; ++frame)
    {
        for (uint16_t ch = 0; ch < count; ++ch)
        {
            const double v = (double) channels[ch][frame] * scale;
            const long q = (long) std::max (low, std::min (high, std::floor (v + 0.5)));
            const uint32_t raw = (uint32_t) (int32_t) q;
            for (size_t b = 0; b < width; ++b)
                buf[at + b] = (uint8_t) ((raw >> (8u * b)) & 0xffu);
            at += width;
        }
    }

    std::ofstream out (path, std::ios::binary | std::ios::trunc);
    if (! out)
        throw std::runtime_error (path + ": cannot open for writing");
    out.write ((const char*) buf.data(), (std::streamsize) buf.size());
    if (! out)
        throw std::runtime_error (path + ": write failed");
}

void writeWavFloat32 (const std::string& path,
                      double sampleRate,
                      const std::vector<std::vector<float>>& channels)
{
    if (channels.empty())
        throw std::runtime_error ("writeWavFloat32 needs at least one channel");
    const size_t frames = channels[0].size();
    for (const auto& channel : channels)
        if (channel.size() != frames)
            throw std::runtime_error ("writeWavFloat32 channels must have equal lengths");

    const uint16_t count = (uint16_t) channels.size();
    const uint32_t rate = (uint32_t) sampleRate;
    const size_t dataSize = frames * count * 4;

    // RIFF + fmt (18 bytes: non-PCM carries cbSize) + fact (required for
    // non-PCM) + data — the same layout, in the same order, as
    // writeWavFloat32 in wav.ts.
    std::vector<uint8_t> buf (12 + 8 + 18 + 8 + 4 + 8 + dataSize, 0);
    size_t at = 0;
    putTag (buf, at, "RIFF");
    putU32 (buf, at + 4, (uint32_t) (buf.size() - 8));
    putTag (buf, at + 8, "WAVE");
    at += 12;
    putTag (buf, at, "fmt ");
    putU32 (buf, at + 4, 18);
    putU16 (buf, at + 8, formatFloat);
    putU16 (buf, at + 10, count);
    putU32 (buf, at + 12, rate);
    putU32 (buf, at + 16, rate * count * 4); // byte rate
    putU16 (buf, at + 20, (uint16_t) (count * 4)); // block align
    putU16 (buf, at + 22, 32);
    putU16 (buf, at + 24, 0); // cbSize
    at += 8 + 18;
    putTag (buf, at, "fact");
    putU32 (buf, at + 4, 4);
    putU32 (buf, at + 8, (uint32_t) frames);
    at += 12;
    putTag (buf, at, "data");
    putU32 (buf, at + 4, (uint32_t) dataSize);
    at += 8;

    for (size_t frame = 0; frame < frames; ++frame)
    {
        for (uint16_t ch = 0; ch < count; ++ch)
        {
            const float f = channels[ch][frame];
            uint32_t raw;
            std::memcpy (&raw, &f, sizeof (raw));
            putU32 (buf, at, raw);
            at += 4;
        }
    }

    std::ofstream out (path, std::ios::binary | std::ios::trunc);
    if (! out)
        throw std::runtime_error (path + ": cannot open for writing");
    out.write ((const char*) buf.data(), (std::streamsize) buf.size());
    if (! out)
        throw std::runtime_error (path + ": write failed");
}

} // namespace field::dsp
