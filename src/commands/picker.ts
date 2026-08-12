// The interactive picker behind `field insert add` (add-insert.md §3):
// an incremental-search list for a TTY. Hand-rolled and deliberately
// disposable — a full TUI is eventually wanted, and that is its own
// stack decision to record against project-core.md §5 when it
// arrives; a prompts library adopted now would quietly pre-answer it.
// The state machine is pure and tested; the terminal shell below it
// stays thin enough to delete without regret.

export interface PickerItem<T> {
  label: string; // what the row shows
  search: string; // what typing matches against (lowercased at build)
  disabled?: string; // shown as the reason; the cursor skips it
  value: T;
}

export type PickerKey =
  | { type: 'char'; ch: string }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'backspace' }
  | { type: 'enter' }
  | { type: 'escape' };

export interface PickerState {
  query: string;
  cursor: number; // index into the *filtered* list
}

// Every whitespace-separated token must match somewhere in the item's
// search string — `au delay` narrows to AU-format delays, which is the
// format-token matching add-insert.md §3 records.
export function filterItems<T>(items: PickerItem<T>[], query: string): PickerItem<T>[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return items;
  return items.filter((item) => tokens.every((token) => item.search.includes(token)));
}

function firstSelectable<T>(filtered: PickerItem<T>[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < filtered.length; i += step) {
    if (filtered[i]!.disabled === undefined) return i;
  }
  return -1;
}

export function reducePicker<T>(
  state: PickerState,
  key: PickerKey,
  items: PickerItem<T>[],
): { state: PickerState; done?: 'selected' | 'cancelled'; selected?: T } {
  const filtered = filterItems(items, state.query);
  switch (key.type) {
    case 'char': {
      const query = state.query + key.ch;
      const next = filterItems(items, query);
      return { state: { query, cursor: Math.max(0, firstSelectable(next, 0, 1)) } };
    }
    case 'backspace': {
      const query = state.query.slice(0, -1);
      const next = filterItems(items, query);
      return { state: { query, cursor: Math.max(0, firstSelectable(next, 0, 1)) } };
    }
    case 'up': {
      const at = firstSelectable(filtered, Math.max(0, state.cursor - 1), -1);
      return { state: { ...state, cursor: at >= 0 ? at : state.cursor } };
    }
    case 'down': {
      const at = firstSelectable(filtered, Math.min(filtered.length - 1, state.cursor + 1), 1);
      return { state: { ...state, cursor: at >= 0 ? at : state.cursor } };
    }
    case 'enter': {
      const item = filtered[state.cursor];
      if (item === undefined || item.disabled !== undefined) return { state };
      return { state, done: 'selected', selected: item.value };
    }
    case 'escape':
      return { state, done: 'cancelled' };
  }
}

// Decode one stdin chunk into picker keys. Arrows arrive as CSI
// sequences; a bare escape cancels; ctrl-c cancels rather than killing
// the process mid-raw-mode (the shell restores the terminal on the
// normal path, and a SIGINT here would skip it).
export function decodeKeys(chunk: Buffer): PickerKey[] {
  const keys: PickerKey[] = [];
  const text = chunk.toString('utf8');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\x1b') {
      if (text[i + 1] === '[' && text[i + 2] === 'A') {
        keys.push({ type: 'up' });
        i += 2;
      } else if (text[i + 1] === '[' && text[i + 2] === 'B') {
        keys.push({ type: 'down' });
        i += 2;
      } else if (text[i + 1] === undefined) {
        keys.push({ type: 'escape' });
      } else {
        // Other escape sequences (right/left/function keys): ignored,
        // and their bytes skipped so they do not land in the query.
        i = text[i + 1] === '[' ? i + 2 : i + 1;
      }
    } else if (ch === '\r' || ch === '\n') {
      keys.push({ type: 'enter' });
    } else if (ch === '\x7f' || ch === '\b') {
      keys.push({ type: 'backspace' });
    } else if (ch === '\x03') {
      keys.push({ type: 'escape' });
    } else if (ch >= ' ') {
      keys.push({ type: 'char', ch });
    }
  }
  return keys;
}

const VISIBLE = 10;

function render(
  title: string,
  state: PickerState,
  filtered: PickerItem<unknown>[],
  previousLines: number,
): number {
  const out = process.stdout;
  if (previousLines > 0) out.write(`\x1b[${previousLines}A`);
  const lines: string[] = [];
  lines.push(`${title}: ${state.query}\x1b[K`);
  // Keep the cursor's row on screen: scroll the window, not the list.
  const top = Math.max(0, Math.min(state.cursor - (VISIBLE - 1), filtered.length - VISIBLE));
  for (let i = top; i < Math.min(top + VISIBLE, filtered.length); i++) {
    const item = filtered[i]!;
    const marker = i === state.cursor ? '\x1b[7m' : '';
    const note = item.disabled !== undefined ? `  (${item.disabled})` : '';
    lines.push(`${marker}  ${item.label}${note}\x1b[0m\x1b[K`);
  }
  if (filtered.length === 0) lines.push('  (no match)\x1b[K');
  // Blank out rows a narrower filter no longer needs.
  for (let i = lines.length; i < previousLines; i++) lines.push('\x1b[K');
  out.write(lines.join('\n') + '\n');
  return lines.length;
}

// Runs the picker on the controlling TTY. Resolves with the selected
// value, or undefined when cancelled. Callers gate on isTTY — this
// function assumes it.
export async function runPicker<T>(title: string, items: PickerItem<T>[]): Promise<T | undefined> {
  const stdin = process.stdin;
  let state: PickerState = { query: '', cursor: 0 };
  let drawn = render(title, state, filterItems(items, ''), 0);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<T | undefined>((resolve) => {
    const finish = (value: T | undefined): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      for (const key of decodeKeys(chunk)) {
        const result = reducePicker(state, key, items);
        state = result.state;
        if (result.done === 'selected') return finish(result.selected);
        if (result.done === 'cancelled') return finish(undefined);
      }
      drawn = render(title, state, filterItems(items, state.query), drawn);
    };
    stdin.on('data', onData);
  });
}
