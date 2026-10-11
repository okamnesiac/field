import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { resolveKeysTargets } from './targets.js';

// What `field keys` arms from its targets (arming.md §2.1): a program by
// name, a MIDI track, or the one MIDI track under a bus, refusing a bus
// with several so you name the ones you mean.

let root: string;

const VOICE = '(\nif ("FIELD_MODE".getenv == "voice") { SynthDef(\\v, {}) } { 0.exit }\n)\n';

function writeTrack(name: string, lines: string[]): void {
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), [`name: ${name}`, ...lines, ''].join('\n'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-keys-targets-'));
  init({ dir: root, name: 'targets' });
  createSong(root, 'creek');
  writeFileSync(join(root, 'shared/instruments/juno.scd'), VOICE);
  writeFileSync(join(root, 'shared/instruments/bass.scd'), VOICE);
  for (const name of ['keys', 'bass', 'keys-bus', 'band', 'keys-loop', 'pad-sc']) createTrack(root, 'creek', name);
  writeTrack('keys', ['inputs:', '  - record:', '      instrument: juno']);
  writeTrack('bass', ['inputs:', '  - record:', '      instrument: bass']);
  writeTrack('keys-bus', [
    'inserts:',
    '  - effect: eq',
    '    bands:',
    '      - type: lowpass',
    '        frequency: 700',
    'inputs:',
    '  - track: keys',
  ]);
  writeTrack('band', ['inputs:', '  - track: keys-bus', '  - track: bass']);
  writeTrack('keys-loop', ['inputs:', '  - track: keys', '    at: [1]', '  - track: keys', '    at: [5]', '  - track: keys-bus']);
  writeTrack('pad-sc', ['inputs: []']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const program = (name: string): string => join(root, 'shared/instruments', `${name}.scd`);

describe('field keys targets', () => {
  it('arms a MIDI track by its record entry, with no takes yet', () => {
    expect(resolveKeysTargets(['creek/track:keys'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: [] },
    ]);
  });

  it('arms the one MIDI track under a bus, and names the effects it does not hear yet', () => {
    expect(resolveKeysTargets(['creek/track:keys-bus'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
    ]);
  });

  it('refuses a bus with several MIDI tracks under it, listing them', () => {
    expect(() => resolveKeysTargets(['creek/track:band'], root)).toThrow(
      'field keys creek/track:band: 2 MIDI tracks are under band, and field keys plays the ones you name: ' +
        'creek/track:keys, creek/track:bass',
    );
  });

  it('counts a MIDI track reached by several paths once, with the effects of every path', () => {
    // keys-loop places keys twice, and once more through keys-bus.
    expect(resolveKeysTargets(['creek/track:keys-loop'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
    ]);
    // Named directly and through its bus, in either order, it keeps the bus.
    for (const targets of [
      ['creek/track:keys', 'creek/track:keys-bus'],
      ['creek/track:keys-bus', 'creek/track:keys'],
    ]) {
      expect(resolveKeysTargets(targets, root)).toEqual([
        { program: program('juno'), track: 'creek/keys', unheardEffects: ['keys-bus'] },
      ]);
    }
  });

  it('refuses a track with no MIDI track on it or under it', () => {
    expect(() => resolveKeysTargets(['creek/track:pad-sc'], root)).toThrow('no MIDI track there');
  });

  it('arms every target at once, instruments and tracks mixed, each once', () => {
    expect(resolveKeysTargets(['creek/track:keys', 'creek/track:bass', 'creek/track:keys', 'juno'], root)).toEqual([
      { program: program('juno'), track: 'creek/keys', unheardEffects: [] },
      { program: program('bass'), track: 'creek/bass', unheardEffects: [] },
      { program: program('juno'), unheardEffects: [] },
    ]);
  });
});
