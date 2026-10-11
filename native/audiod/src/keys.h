// The native half of `field keys` (keyboard-instrument.md §2.5): a
// virtual MIDI source driven by NDJSON on stdin, and a monitor that
// prints what a named source sends. Both are short-lived subprocesses,
// apart from the daemon's transport and socket, and both speak NDJSON on
// stdout and nothing else.
#pragma once

#include <juce_core/juce_core.h>

namespace field
{
// Reports the keyboard layout (macOS), publishes the source, sends each
// {"midi":[...]} line from stdin, and closes the source at end of input.
int runKeys (const juce::String& name);

// Prints each message from the source named `name` until end of input,
// SIGTERM, or SIGINT.
int runMidiMonitor (const juce::String& name);
} // namespace field
