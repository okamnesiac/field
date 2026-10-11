#pragma once

#include <juce_core/juce_core.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

#include "live.h"

namespace field
{

// The device's input for the block the callback is in, for the capture
// inputs to read (live-supercollider.md §12): presented before the
// session renders and cleared after, both on the audio thread, which is
// the only thread that reads it.
struct CaptureBlock
{
    const float* const* in = nullptr;
    int numInputs = 0;
    int frames = 0;
    uint64_t generation = 0;

    void present (const float* const* input, int count, int n)
    {
        in = input;
        numInputs = count;
        frames = n;
        ++generation;
    }
    void clear()
    {
        in = nullptr;
        numInputs = 0;
        frames = 0;
    }
};

// Host monitoring (live-supercollider.md §12): an armed audio input read
// by the session input window of the same name, so the track it records
// on is heard through its inserts, its buses, and main while the take
// itself stays dry. It reads the block the callback presented, from a
// cursor that starts again each block, because the session reads a block
// in steps when a loop wraps inside it. One channel, on both sides.
class CaptureInput final : public LiveInput
{
public:
    // `channel` is the index in the callback's input array, which holds
    // only the device's active inputs.
    CaptureInput (std::shared_ptr<CaptureBlock> block, int channel);

    void read (float* left, float* right, int n) override;

    // Disarming stops the reading; a session still holding this input
    // reads silence until it lets go. Message thread.
    void close() { channel.store (-1); }

    // For `status`: frames read and the loudest sample since a client
    // last read the peak, which `consumePeak` resets.
    juce::var stats (bool consumePeak = false);

private:
    std::shared_ptr<CaptureBlock> block;
    std::atomic<int> channel;
    uint64_t seen = 0; // audio thread: the block the cursor counts in
    int cursor = 0;
    std::atomic<juce::int64> framesRead { 0 };
    std::atomic<float> peak { 0.0f };
};

// --capture-selftest: a CaptureInput read whole, in the steps a loop
// wrap makes, past its block, with nothing presented, and closed. Empty
// string when every case holds.
std::string runCaptureSelfTest();

} // namespace field
