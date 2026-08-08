#pragma once

#include <juce_core/juce_core.h>

// Validating a render plan, once, before anything reads it.
//
// The first four fail-closed bugs in this boundary were each fixed at
// their use site, and a fifth audit found the parser still failing open
// in every part that had not been patched yet: numeric strings and
// objects coerced by `juce::var`'s casts, unknown keys ignored, `version:
// 2.9` passing an exact gate by truncation, an EQ with no bands rendering
// as a no-op. Patching use sites keeps that serial. So the shape is
// checked here in one place, and the renderer downstream consumes only a
// plan that has already been proven to match.
//
// Two things this deliberately does *not* try to be.
//
// It is not a mirror of the zod schema's user-input ranges. `frequency`
// being within 10–24000 is zod's job on the way in, and duplicating every
// bound here would create exactly the drift this file exists to prevent.
// What is enforced is structure — types, allowed keys, required and
// optional fields, collection sizes — plus the domains where a bad value
// is unsafe or silently wrong rather than merely out of range.
//
// And it is not a substitute for the daemon rejecting what it cannot
// render. Unknown keys are refused here precisely because an additive
// control-plane field must not be able to describe work this binary will
// not perform; that is the same rule as the unknown effect, the unknown
// band type and the missing array, applied to the whole shape at once.

namespace field
{

// Throws std::runtime_error naming the offending path and reason.
void validatePlan (const juce::var& plan);

} // namespace field
