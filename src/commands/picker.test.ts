import { describe, expect, it } from 'vitest';
import { decodeKeys, filterItems, initialState, reducePicker, type PickerItem, type PickerState } from './picker.js';

const item = (label: string, disabled?: string): PickerItem<string> => ({
  label,
  search: label.toLowerCase(),
  ...(disabled !== undefined ? { disabled } : {}),
  value: label,
});

describe('picker filtering', () => {
  it('matches every token somewhere, case-insensitive', () => {
    const items = [item('AUDelay — Apple  au 1.6.0'), item('Field Fixture — Field  vst3 1.0.0')];
    expect(filterItems(items, 'delay').map((i) => i.value)).toEqual(['AUDelay — Apple  au 1.6.0']);
    // Format tokens narrow (add-insert.md §3): "au delay" is the AU delays.
    expect(filterItems(items, 'au delay')).toHaveLength(1);
    expect(filterItems(items, 'vst3 field')).toHaveLength(1);
    expect(filterItems(items, 'FIELD fix')).toHaveLength(1);
    expect(filterItems(items, 'zz')).toHaveLength(0);
    expect(filterItems(items, '  ')).toHaveLength(2);
  });
});

describe('picker reduction', () => {
  const items = [item('aaa'), item('bbb', 'no version'), item('ccc')];
  const start: PickerState = { query: '', cursor: 0 };

  it('typing narrows and re-homes the cursor to the first selectable row', () => {
    const typed = reducePicker(start, { type: 'char', ch: 'b' }, items);
    expect(typed.state.query).toBe('b');
    // Only the disabled row matches: cursor clamps rather than landing on it.
    expect(reducePicker(typed.state, { type: 'enter' }, items).done).toBeUndefined();
    const widened = reducePicker(typed.state, { type: 'backspace' }, items);
    expect(widened.state.query).toBe('');
    expect(widened.state.cursor).toBe(0);
  });

  it('arrows skip disabled rows in both directions', () => {
    const down = reducePicker(start, { type: 'down' }, items);
    expect(down.state.cursor).toBe(2); // skipped bbb
    const up = reducePicker(down.state, { type: 'up' }, items);
    expect(up.state.cursor).toBe(0);
  });

  it('enter selects the cursor row; escape cancels', () => {
    const selected = reducePicker(start, { type: 'enter' }, items);
    expect(selected.done).toBe('selected');
    expect(selected.selected).toBe('aaa');
    expect(reducePicker(start, { type: 'escape' }, items).done).toBe('cancelled');
  });

  it('starts on the default row, so bare enter selects it (Bugbot on #155)', () => {
    // The order chooser's shape: end is the labeled default. A cursor
    // hardwired to 0 made bare Enter place before the first insert —
    // diverging from the label and from the silent non-TTY default.
    const positions = [item('before 1176'), item('between 1176 and Altiverb'), item('at the end')];
    const state = initialState(positions, 2);
    const selected = reducePicker(state, { type: 'enter' }, positions);
    expect(selected.done).toBe('selected');
    expect(selected.selected).toBe('at the end');
    // A disabled default falls forward, then backward — navigation's
    // own skip rule, and never a disabled landing.
    expect(initialState(items, 1).cursor).toBe(2);
    expect(initialState([item('aaa'), item('bbb', 'no version')], 1).cursor).toBe(0);
    // Out-of-range clamps instead of vanishing off the list.
    expect(initialState(positions, 99).cursor).toBe(2);
  });
});

describe('key decoding', () => {
  it('decodes arrows, enter, backspace, escape, ctrl-c, and text', () => {
    expect(decodeKeys(Buffer.from('\x1b[A'))).toEqual([{ type: 'up' }]);
    expect(decodeKeys(Buffer.from('\x1b[B'))).toEqual([{ type: 'down' }]);
    expect(decodeKeys(Buffer.from('\r'))).toEqual([{ type: 'enter' }]);
    expect(decodeKeys(Buffer.from('\x7f'))).toEqual([{ type: 'backspace' }]);
    expect(decodeKeys(Buffer.from('\x1b'))).toEqual([{ type: 'escape' }]);
    expect(decodeKeys(Buffer.from('\x03'))).toEqual([{ type: 'escape' }]);
    expect(decodeKeys(Buffer.from('au'))).toEqual([
      { type: 'char', ch: 'a' },
      { type: 'char', ch: 'u' },
    ]);
    // An unhandled CSI sequence is skipped whole, not typed into the query.
    expect(decodeKeys(Buffer.from('\x1b[Cx'))).toEqual([{ type: 'char', ch: 'x' }]);
  });
});
