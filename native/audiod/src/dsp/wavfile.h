#pragma once

#include <string>
#include <vector>

// WAV I/O for the render path, transliterated from src/audio/wav.ts and
// byte-compatible with it on the way out.
//
// Hand-written rather than JUCE's AudioFormatManager on purpose. Two
// reasons, both about control rather than taste: the reference decodes
// integer PCM by dividing by 2^(bits−1) with no dither and no clamp, and a
// reader that scaled even slightly differently would make the same input
// file decode to different samples on the two sides of this migration; and
// render-pipeline.md chunk 6 wants byte-identical output across platforms,
// which is only assertable if we own the bytes we emit. The writer here
// reproduces writeWavFloat32's header exactly — 18-byte fmt with cbSize,
// then the fact chunk non-PCM requires — so a C++ render and a TypeScript
// render of the same input differ in no byte at all when the DSP agrees.
//
// Little-endian is assumed, as the reference assumes it. Both supported
// platforms are little-endian; a big-endian port would need to say so
// here rather than discover it in the field.

namespace field::dsp
{

struct WavData
{
    double sampleRate = 0.0;
    std::vector<std::vector<float>> channels; // one per channel, equal lengths
};

// Throws std::runtime_error naming the file and the reason, in the same
// terms the TypeScript reader uses.
WavData readWav (const std::string& path);

void writeWavFloat32 (const std::string& path,
                      double sampleRate,
                      const std::vector<std::vector<float>>& channels);

// Integer PCM, 16 or 24 bit — what `normalize` emits for those targets.
// Expects samples already on the quantization grid (dsp::ditherTo), so
// the conversion here is exact and the dither stays visible in the DSP
// rather than hidden in the file writer.
void writeWavInt (const std::string& path,
                  double sampleRate,
                  const std::vector<std::vector<float>>& channels,
                  int bitDepth);

} // namespace field::dsp
