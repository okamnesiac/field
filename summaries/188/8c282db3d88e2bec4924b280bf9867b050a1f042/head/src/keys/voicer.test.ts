import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sclangCommand, scScript } from '../generators/supercollider.js';

// sc/voicer.scd through real sclang (keyboard-instrument.md §12.3). The
// voicer is an Event, and an Event runs a real method before its own entry
// of the same name, so an entry named like one of Event's methods silently
// does something else. Only sclang can show that.

const sclang = (() => {
  try {
    return sclangCommand();
  } catch {
    return undefined;
  }
})();

// Runs `body` with `voicer` bound to a voicer whose callbacks print what
// they are asked to do, and returns those lines.
function runVoicer(body: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'field-voicer-'));
  try {
    const script = join(dir, 'voicer-probe.scd');
    writeFileSync(
      script,
      [
        '(',
        `var voicer = thisProcess.interpreter.executeFile(${JSON.stringify(scScript('voicer.scd'))}).(`,
        '\t{ |note, velocity, freq, mod| ("start " ++ note ++ " mod " ++ mod.round(0.01)).postln; note },',
        '\t{ |voice, control, value| (control ++ " " ++ voice ++ " " ++ value.round(0.01)).postln },',
        '\t{ |voice| ("release " ++ voice).postln }',
        ');',
        body,
        '"done".postln;',
        '0.exit;',
        ')',
        '',
      ].join('\n'),
    );
    const run = spawnSync(sclang!, [script], { encoding: 'utf8', timeout: 60_000 });
    return run.stdout.split('\n').filter((line) => /^(start|freq|mod|release|done)\b/.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(sclang === undefined)('the voicer through real sclang', () => {
  it('still plays after forgetVoices, which the host calls when its server restarts', { timeout: 60_000 }, () => {
    expect(
      runVoicer(['voicer.noteOn(0, 60, 100);', 'voicer.forgetVoices;', 'voicer.noteOn(0, 62, 100);', 'voicer.noteOff(0, 62);'].join('\n')),
    ).toEqual(['start 60 mod 0.0', 'start 62 mod 0.0', 'release 62', 'done']);
  });

  it('sets mod from CC 1 on every sounding voice, and starts new voices with it', { timeout: 60_000 }, () => {
    expect(
      runVoicer(['voicer.noteOn(0, 60, 100);', 'voicer.cc(0, 1, 127);', 'voicer.noteOn(0, 64, 100);', 'voicer.cc(0, 1, 0);'].join('\n')),
    ).toEqual(['start 60 mod 0.0', 'mod 60 1.0', 'start 64 mod 1.0', 'mod 60 0.0', 'mod 64 0.0', 'done']);
  });
});
