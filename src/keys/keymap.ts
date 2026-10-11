import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { keymapSchema, toKeymap, type Keymap } from '../schema/keymap.js';
import { watchText } from './watch.js';

export const KEYMAP_ENV = 'FIELD_KEYMAP';
export const DEFAULT_KEYMAP = 'musical';

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

// Reloads the keymap at `path` each time a save changes it (watch.ts says
// how the watch survives an editor's rename-on-save), with the keymap or
// why it did not load (keyboard-instrument.md §2.4).
export function watchKeymap(path: string, onReload: (result: ReloadResult) => void, settleMs = 50): () => void {
  return watchText(
    path,
    (text) => {
      try {
        onReload({ keymap: parseKeymap(text, path) });
      } catch (err) {
        onReload({ error: err instanceof KeymapError ? err : new KeymapError(path, [(err as Error).message]) });
      }
    },
    settleMs,
  );
}
