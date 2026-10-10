#pragma once

#include <juce_core/juce_core.h>

#include <vector>

// The metronome (recording.md §7): the CLI projects the tempo map into a
// schedule — timeline sample positions with accent flags, at the rate the
// bed's positions count in — and the engine synthesizes the ticks in the
// callback, against the same clock the capture uses. The daemon still
// never learns what a bar is (playback.md §3.6); a count-in is simply a
// schedule that starts before the record position.
//
// The tick is the one click.ts used to bake into a temp copy of the
// artifact: 15 ms of sine, G6 on the downbeat and C6 elsewhere, decaying
// over 4 ms, at 0.4. It is added to every output channel, never to the
// capture, and never to anything `field build` renders — the click is
// monitoring, not content. Rendering happens in the device domain: a
// schedule at 48 kHz played through a 44.1 kHz device scales each tick's
// position by the rate ratio, so the tick lands at the same instant.
//
// Threading: setSchedule runs on the message thread and swaps the vector
// under a lock the callback only try-locks — a missed block is a block
// without a click, the same discipline as the live session's lock.

namespace field
{

struct ClickTick
{
    juce::int64 sample = 0; // on the bed's timeline, at Schedule::rate
    bool accent = false;
};

class Click
{
public:
    // Parses the wire shape: {"rate": 48000, "ticks": [{"sample": n,
    // "accent": bool}, ...]}. Ticks are sorted; an empty list clears.
    // Throws std::runtime_error on a malformed schedule.
    void setSchedule (const juce::var& schedule);
    void clear();
    int tickCount() const;

    // Audio thread. `position` is the bed's block-start position in its
    // own samples (at the schedule's rate); `deviceRate` is the rate of
    // the `n` frames in `out`. Adds the ticks whose positions fall in this
    // block, and continues any tick still ringing from the last one.
    void render (juce::int64 position, double deviceRate, float* const* out, int numChannels, int n) noexcept;

private:
    struct Voice
    {
        double hz = 0.0;
        int elapsed = 0; // frames rendered so far
        int startOffset = 0; // frame within the current block where it begins
        bool active = false;
    };

    juce::CriticalSection lock;
    std::vector<ClickTick> ticks; // sorted by sample
    double rate = 0.0;
    Voice voices[4];
};

} // namespace field
