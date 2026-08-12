// Hosted plugins (plugin-hosting.md chunk 1): scanning, probing, and the
// offline render arm. Everything here runs in subprocesses — the probe
// because a crashy plugin must not kill the scan, the render because
// that is where --render already lives (render-pipeline.md decision 6).
#pragma once

#include <juce_core/juce_core.h>

#include <string>
#include <vector>

namespace field
{
// --scan-probe <format> <fileOrIdentifier> <outFile>: describe every
// plugin type in one candidate, instantiating each to read its
// parameter table, one JSON object per line into <outFile>. A file, not
// stdout, because instantiating real plugins runs their code and real
// plugins chatter freely on stdout — the parent ignores the child's
// streams entirely and trusts only the file. Runs in its own process so
// a crash is a skip, recorded by the parent.
int runScanProbe (const std::string& formatName,
                  const std::string& candidate,
                  const std::string& outPath);

// --scan <format>: enumerate candidates in the format's default
// locations plus FIELD_PLUGIN_PATH, spawn ourselves with --scan-probe
// per candidate, and aggregate the surviving lines to stdout. Candidates
// whose probe dies are reported as {"failed": <candidate>} lines rather
// than dropped silently.
int runScan (const std::string& formatName, const std::string& exePath);

// --state-capture <format> <identifier> <paramsJson> <out>: instantiate,
// apply params through the same natural-value path the render uses, and
// write getStateInformation's bytes to <out>. Blobs are captured, never
// hand-written — a hosted instance's state stream has a format of its
// own (VST3 preset framing), which is the whole reason the chunk is
// opaque. The editor era's recapture (chunk 3) is this same verb driven
// by session signals.
int runStateCapture (const std::string& formatName,
                     const std::string& identifier,
                     const std::string& paramsJson,
                     const std::string& outPath);

// The render arm: instantiate, restore state, overlay params
// (decision 5), process with the track-local playhead (decision 13),
// trim declared latency, and ring out the tail (decision 11). Replaces
// `channels` with the processed buffers, which may be longer.
void applyPluginInsert (const juce::var& insert,
                        std::vector<std::vector<float>>& channels,
                        double sampleRate);

// True once hosting has initialised the JUCE runtime in this process.
// When it has, C++ static teardown at exit is unsafe: the runtime's
// DeletedAtShutdown list can hold entries whose memory belongs to a
// plugin module that already unloaded (measured — deleteAll() died in
// free() after a successful render). Subprocess modes consult this and
// leave via exitSubprocess instead of running finalizers.
bool hostingWasUsed();

// Flush and _Exit: the subprocess's artifact is already on disk or on
// stdout, and teardown has nothing left to contribute but the crash
// above.
[[noreturn]] void exitSubprocess (int code);
} // namespace field
