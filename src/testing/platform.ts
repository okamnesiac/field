import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Capability probes for the tests that shell out to a macOS binary.
//
// linux-portability.md decision 4 splits CI "by what a test needs, not by
// platform loyalty", and the guard is deliberately per test rather than
// per file: the nine platform-bound cases live in four files holding 72
// tests, so excluding the files would take 63 platform-independent graph,
// stem and DSP tests off the Linux job — the code that job exists to
// exercise.
//
// Probing for the binary rather than checking `process.platform` is the
// idiom the suite already had before this file existed
// (`describe.skipIf(!sclangPresent)`, `describe.skipIf(!binary)`). It
// keeps the reason in the test instead of in CI config, and it states the
// real dependency: these tests need a program, and a platform only
// because that is where the program is.
function onPath(binary: string): boolean {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && existsSync(join(dir, binary)));
}

// `hasSay` was here. The `say` rule is gone (render-pipeline.md chunk 5,
// voice-generation.md §5), and with it the only reason to probe for a
// macOS-only binary that was never going to grow a Linux branch.

// macOS audio conversion, used by `normalize`. Temporary by decision:
// render-pipeline.md chunk 5 puts sample-rate conversion in the daemon's
// built-in tier, and this probe retires with the last
// `execFile('afconvert')`.
export const hasAfconvert = onPath('afconvert');
