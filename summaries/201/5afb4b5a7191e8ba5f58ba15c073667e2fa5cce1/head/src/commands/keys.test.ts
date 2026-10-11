import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap, parseKeymap } from '../keys/keymap.js';
import { KeysSession } from '../keys/session.js';
import { instrumentState, instrumentText, statusText } from './keys.js';

// field keys' status line: the sounding notes come last, so playing
// changes only the end of the line, and a narrow terminal shortens what
// comes before them instead of the notes.

function musicalTyping(): KeysSession {
  return new KeysSession(loadKeymap(join(builtinKeymapDir(), 'musical-typing.yaml')));
}

describe('the status line', () => {
  it('ends with the sounding notes, after anything else it has to say', () => {
    const session = musicalTyping();
    expect(statusText(session, undefined, undefined, 200)).toBe(
      'Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 0 · –',
    );
    session.press('KeyA');
    session.press('KeyD');
    expect(statusText(session, undefined, 'KeyA is both a note and a control', 200)).toBe(
      'Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 0 · keymap not reloaded: KeyA is both a note and a control · C4 E4',
    );
  });

  it('shows the modulation wheel where the keymap can set it', () => {
    const session = musicalTyping();
    session.press('Digit6');
    session.release('Digit6');
    expect(statusText(session, undefined, undefined, 200)).toBe(
      'Field Keys · musical-typing · transpose 0 · velocity 100 · bend +0 · mod 76 · –',
    );
    const tracker = new KeysSession(loadKeymap(join(builtinKeymapDir(), 'tracker.yaml')));
    expect(statusText(tracker, undefined, undefined, 200)).not.toMatch(/bend|mod/);
  });

  it('shows the pitch bend while a bend key is held, at the same width', () => {
    const session = musicalTyping();
    session.press('KeyA');
    const rest = statusText(session, undefined, undefined, 200);
    session.press('Digit1');
    const bent = statusText(session, undefined, undefined, 200);
    expect(bent).toBe('Field Keys · musical-typing · transpose 0 · velocity 100 · bend -1 · mod 0 · C4');
    expect(bent).toHaveLength(rest.length);
    session.release('Digit1');
    expect(statusText(session, undefined, undefined, 200)).toBe(rest);
  });

  it('prints every bend with the decimal places of the finest bend in the keymap', () => {
    const session = new KeysSession(
      parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Digit1: { bend: -1 }, Digit2: { bend: 0.25 } }\n', 't.yaml'),
    );
    session.press('KeyA');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.00 · C4');
    session.press('Digit2');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.25 · C4');
    session.release('Digit2');
    session.press('Digit1');
    expect(statusText(session, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend -1.00 · C4');
    const third = new KeysSession(parseKeymap('name: t\nnotes: { KeyA: 0 }\ncontrols: { Digit1: { bend: 0.333333 } }\n', 't.yaml'));
    third.press('Digit1');
    expect(statusText(third, undefined, undefined, 200)).toBe('Field Keys · t · transpose 0 · velocity 100 · bend +0.3333 · –');
  });

  it('shortens the text before the notes to fit, never the notes', () => {
    const session = musicalTyping();
    session.press('KeyA');
    session.press('KeyD');
    const line = statusText(session, undefined, undefined, 30);
    expect(line).toBe('Field Keys · musical-… · C4 E4');
    expect(line).toHaveLength(30);
  });
});

describe('the instrument line', () => {
  const live = { state: 'live' as const, device: 'MacBook Pro Speakers', sampleRate: 48000 };

  it('names each armed track and its instrument, and an instrument given by program alone', () => {
    const state = instrumentState([
      { program: '/p/shared/instruments/juno.scd', track: 'creek/keys', unheardEffects: [] },
      { program: '/p/shared/instruments/bass.scd', track: 'creek/bass', unheardEffects: [] },
      { program: '/p/shared/instruments/pad.scd', unheardEffects: [] },
    ])!;
    expect(instrumentText({ ...state, status: live })).toBe(
      'keys (juno) + bass (bass) + pad live at 48000 Hz on MacBook Pro Speakers',
    );
  });

  it('ends with the effects not heard, each once, and why when routing them was not possible', () => {
    const armed = [
      { program: '/p/juno.scd', track: 'creek/keys', unheardEffects: ['keys-bus'] },
      { program: '/p/bass.scd', track: 'creek/bass', unheardEffects: ['keys-bus', 'band'] },
    ];
    const state = instrumentState(armed)!;
    expect(instrumentText({ ...state, status: live })).toBe(
      'keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry: the effects on keys-bus, band are not heard',
    );
    expect(instrumentText({ ...instrumentState(armed, false, 'FieldOut is not built: run pnpm build:native')!, status: live })).toBe(
      'keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry: the effects on keys-bus, band are not heard (FieldOut is not built: run pnpm build:native)',
    );
    // A route that failed says why even with no effects to name.
    expect(
      instrumentText({
        ...instrumentState([{ program: '/p/bass.scd', track: 'creek/bass', unheardEffects: [] }], false, 'FieldOut is not built: run pnpm build:native')!,
        status: live,
      }),
    ).toBe('bass (bass) live at 48000 Hz on MacBook Pro Speakers · dry (FieldOut is not built: run pnpm build:native)');
    // Routed, but scsynth never ran the route: nothing is heard at all.
    expect(instrumentText({ ...instrumentState(armed, true)!, silent: 'FieldOut did not load', status: live })).toBe(
      'keys (juno) + bass (bass) is silent: FieldOut did not load',
    );
    // Routed through the daemon, the voices pass through every effect.
    expect(instrumentText({ ...instrumentState(armed, true, 'unused')!, status: live })).toBe(
      'keys (juno) + bass (bass) live at 48000 Hz on MacBook Pro Speakers',
    );
    expect(instrumentText({ ...state, status: live, reload: { failed: 'juno.scd does not compile' } })).toBe(
      'keys (juno) + bass (bass) kept its last voice: juno.scd does not compile',
    );
  });
});
