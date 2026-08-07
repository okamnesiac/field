#pragma once

#include <string>

// Offline render as a subprocess: `field-audiod --render <plan.json>`
// (render-pipeline.md decision 6). No socket, no device, no transport —
// the process reads a plan, writes one file, and exits.
//
// That shape is deliberate. A `render` verb on the control socket would
// make a build action contend with whatever the developer is listening
// to, and would stop two `field build` runs proceeding independently;
// builds are hermetic and parallel by construction, and an offline render
// needs none of the daemon's state.
//
// The plan is the schema's own insert objects, verbatim:
//
//   { "input": "…", "output": "…", "inserts": [ { "effect": "eq", … } ] }
//
// so the control plane serializes what it already has (src/schema/
// effects.ts) with no translation layer to drift. Musical time never
// appears here — decision 7 keeps bars, beats and clip placement in the
// control plane, and this boundary sees sample counts and file paths.

namespace field
{

// Returns an empty string on success, otherwise the error to report.
std::string runRender (const std::string& planPath);

} // namespace field
