import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

// Calls `onChange` with a file's text each time a save changes it: a
// keymap given by path (keyboard-instrument.md §2.4) and an instrument's
// program (§14) both reload this way.
//
// Watches the file's directory, not the file: many editors save by
// renaming a temporary file over the original, and fs.watch on a file
// keeps following the original inode, so the watch would end at the
// first such save. Calls only when the text changes: macOS can deliver an
// event for a write made just before the watch began, or one with no
// filename.
export function watchText(path: string, onChange: (text: string) => void, settleMs = 50): () => void {
  const name = basename(path);
  const read = (): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  };
  let loaded = read();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename !== null && filename !== name) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // A rename-on-save can fire between the unlink and the rename; the
      // event that follows reads the finished file.
      const text = read();
      if (text === undefined || text === loaded) return;
      loaded = text;
      onChange(text);
    }, settleMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
