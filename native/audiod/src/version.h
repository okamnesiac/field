#pragma once

// The daemon's own version, reported in `hello` for humans (`field
// transport status` prints it) and stamped into every take's manifest.
// Clients gate on `features`, never on this string (realtime.md §3).
namespace field
{
// 0.12: the input side — arm/record/stop, transactional capture,
// recovery (recording.md chunk 1).
// 0.13: the metronome in the engine and record's `start` — count-in
// and a sample-exact punch-in (recording.md chunk 3).
// 0.14: the region loop, punch-out, and loop takes (recording.md
// chunk 4).
constexpr const char* daemonVersion = "0.14.0";
}
