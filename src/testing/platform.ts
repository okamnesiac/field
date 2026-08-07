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

// macOS text-to-speech. Permanent: `say` does not port and is not made to
// (linux-portability.md decision 3) — it retires when a real voice library
// arrives, rather than growing a Linux branch.
export const hasSay = onPath('say');

// macOS audio conversion, used by `normalize` and by `say`'s AIFF→WAV
// step. Temporary by decision: render-pipeline.md chunk 5 puts sample-rate
// conversion in the daemon's built-in tier, and this probe retires with
// the last `execFile('afconvert')`.
export const hasAfconvert = onPath('afconvert');
