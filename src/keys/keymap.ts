import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { keymapSchema, toKeymap, type Keymap } from '../schema/keymap.js';

export const KEYMAP_ENV = 'FIELD_KEYMAP';
export const DEFAULT_KEYMAP = 'musical-typing';

export type KeymapSource = { kind: 'builtin'; name: string; path: string } | { kind: 'file'; path: string };

export function builtinKeymapDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'keymaps');
}

export function builtinKeymapNames(dir = builtinKeymapDir()): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .map((file) => file.slice(0, -'.yaml'.length))
    .sort();
}

// A bare name only ever names a built-in, and anything else is a path,
// the rule programPath() applies to instruments plus one test: a name
// ending in .yaml is a path too (keyboard-instrument.md §3). No search
// path, so a keymap of yours can never shadow a built-in or be shadowed
// by one an upgrade adds.
export function resolveKeymapSource(
  spec: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; cwd?: string; builtinDir?: string } = {},
): KeymapSource {
  const chosen = spec ?? (env[KEYMAP_ENV] !== undefined && env[KEYMAP_ENV] !== '' ? env[KEYMAP_ENV] : DEFAULT_KEYMAP);
  if (chosen.includes('/') || chosen.endsWith('.yaml')) {
    const expanded = chosen.startsWith('~/') ? join(options.home ?? homedir(), chosen.slice(2)) : chosen;
    return { kind: 'file', path: resolve(options.cwd ?? process.cwd(), expanded) };
  }
  const dir = options.builtinDir ?? builtinKeymapDir();
  const path = join(dir, `${chosen}.yaml`);
  if (!existsSync(path)) {
    throw new Error(
      `no built-in keymap named "${chosen}" (built-ins: ${builtinKeymapNames(dir).join(', ')}); ` +
        `a bare name names a built-in, so give a path for a keymap of your own, such as ./${chosen}.yaml`,
    );
  }
  return { kind: 'builtin', name: chosen, path };
}

export class KeymapError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`${path}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

export function parseKeymap(text: string, path: string): Keymap {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new KeymapError(path, doc.errors.map((e) => e.message.split('\n')[0]!));
  const parsed = keymapSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new KeymapError(
      path,
      parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
    );
  }
  return toKeymap(parsed.data);
}

export function loadKeymap(path: string): Keymap {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new KeymapError(path, [(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message]);
  }
  return parseKeymap(text, path);
}

export type ReloadResult = { keymap: Keymap } | { error: KeymapError };

// Watches the keymap's directory, not the file: many editors save by
// renaming a temporary file over the original, and fs.watch on a file
// keeps following the original inode, so the watch would end at the
// first such save (keyboard-instrument.md §2.4).
// Reloads only when the text changes: macOS can deliver an event for a
// write made just before the watch began, or one with no filename.
export function watchKeymap(path: string, onReload: (result: ReloadResult) => void, settleMs = 50): () => void {
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
      // event that follows reloads the finished file.
      const text = read();
      if (text === undefined || text === loaded) return;
      loaded = text;
      try {
        onReload({ keymap: parseKeymap(text, path) });
      } catch (err) {
        onReload({ error: err instanceof KeymapError ? err : new KeymapError(path, [(err as Error).message]) });
      }
    }, settleMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
