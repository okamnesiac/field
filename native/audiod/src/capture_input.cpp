#include "capture_input.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace field
{

CaptureInput::CaptureInput (std::shared_ptr<CaptureBlock> captureBlock, int inputChannel)
    : block (std::move (captureBlock)), channel (inputChannel)
{
}

void CaptureInput::read (float* left, float* right, int n)
{
    if (block->generation != seen)
    {
        seen = block->generation;
        cursor = 0;
    }
    const int c = channel.load (std::memory_order_relaxed);
    const float* source = block->in != nullptr && c >= 0 && c < block->numInputs ? block->in[c] : nullptr;
    const int have = source != nullptr ? std::clamp (block->frames - cursor, 0, n) : 0;
    float loudest = 0.0f;
    for (int i = 0; i < have; ++i)
    {
        const float sample = source[cursor + i];
        left[i] = sample;
        right[i] = sample;
        loudest = std::max (loudest, std::abs (sample));
    }
    std::fill (left + have, left + n, 0.0f);
    std::fill (right + have, right + n, 0.0f);
    cursor += n;
    if (have > 0)
    {
        framesRead.fetch_add (have, std::memory_order_relaxed);
        if (loudest > peak.load (std::memory_order_relaxed))
            peak.store (loudest, std::memory_order_relaxed);
    }
}

juce::var CaptureInput::stats (bool consumePeak)
{
    auto* object = new juce::DynamicObject();
    object->setProperty ("kind", "capture");
    object->setProperty ("read", (juce::int64) framesRead.load (std::memory_order_relaxed));
    object->setProperty ("peak", (double) (consumePeak ? peak.exchange (0.0f) : peak.load()));
    return juce::var (object);
}

// Exactly equal, said without ==, which -Wfloat-equal flags: the test
// reads samples back unchanged, so nothing nearer will do.
static bool same (float a, float b) { return ! (a < b) && ! (b < a); }

std::string runCaptureSelfTest()
{
    auto block = std::make_shared<CaptureBlock>();
    std::vector<float> first (512), second (512);
    for (int i = 0; i < 512; ++i)
    {
        first[(size_t) i] = (float) i / 512.0f;
        second[(size_t) i] = 0.5f;
    }
    const float* channels[2] = { first.data(), second.data() };
    std::vector<float> left (600), right (600);
    CaptureInput input (block, 1);
    auto expect = [&] (bool held, const char* what) { return held ? std::string() : std::string (what); };

    // Nothing presented: silence, and nothing counted.
    std::fill (left.begin(), left.end(), 1.0f);
    input.read (left.data(), right.data(), 512);
    if (auto error = expect (left[0] == 0.0f && right[511] == 0.0f, "an unpresented block was not silent"); ! error.empty())
        return error;

    // A whole block: its channel, on both sides.
    block->present (channels, 2, 512);
    input.read (left.data(), right.data(), 512);
    block->clear();
    if (auto error = expect (left[0] == 0.5f && right[511] == 0.5f, "a whole block did not read its channel"); ! error.empty())
        return error;

    // The steps a loop wrap makes: the second carries on where the first
    // stopped, and a step past the block reads silence beyond it.
    CaptureInput ramp (block, 0);
    block->present (channels, 2, 512);
    ramp.read (left.data(), right.data(), 200);
    if (auto error = expect (same (left[199], first[199]), "the first step did not read the block's start"); ! error.empty())
        return error;
    ramp.read (left.data(), right.data(), 400);
    block->clear();
    if (auto error = expect (same (left[0], first[200]) && same (left[311], first[511]) && left[312] == 0.0f && right[399] == 0.0f,
                             "the second step did not carry on, or did not pad past the block");
        ! error.empty())
        return error;

    // The next block starts the cursor again.
    block->present (channels, 2, 512);
    ramp.read (left.data(), right.data(), 512);
    block->clear();
    if (auto error = expect (same (left[0], first[0]) && same (left[511], first[511]), "the next block did not start again"); ! error.empty())
        return error;

    // A channel the block does not hold, and a closed input: silence.
    CaptureInput beyond (block, 2);
    block->present (channels, 2, 512);
    beyond.read (left.data(), right.data(), 512);
    ramp.close();
    ramp.read (right.data(), left.data(), 512);
    block->clear();
    if (auto error = expect (left[0] == 0.0f && right[0] == 0.0f && left[511] == 0.0f && right[511] == 0.0f,
                             "a missing channel or a closed input was not silent");
        ! error.empty())
        return error;

    // The counters: what was read, and the peak that reading resets.
    const auto stats = input.stats (true);
    if (auto error = expect ((juce::int64) stats["read"] == 512 && (double) stats["peak"] == 0.5 && (double) input.stats()["peak"] == 0.0,
                             "the counters did not count the one block read");
        ! error.empty())
        return error;
    return {};
}

} // namespace field
