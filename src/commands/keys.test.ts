import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKeymapDir, loadKeymap } from '../keys/keymap.js';
import { KeysSession } from '../keys/session.js';
import { statusText } from './keys.js';

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
      'Field Keys · musical-typing · transpose 0 · velocity 100 · –',
    );
    session.press('KeyA');
    session.press('KeyD');
    expect(statusText(session, undefined, 'KeyA is both a note and a control', 200)).toBe(
      'Field Keys · musical-typing · transpose 0 · velocity 100 · keymap not reloaded: KeyA is both a note and a control · C4 E4',
    );
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
