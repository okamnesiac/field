import { readFileSync } from 'node:fs';

// The version the package declares, read once. `cli.ts` had its own copy
// of the literal and `version.ts` its own copy of the parse — two ways
// for the number a user is told to disagree with the package they have,
// in the change whose whole point was removing exactly that (#70 review).
//
// Deliberately dependency-free: `cli.ts` needs this at module load to
// configure `--version`, and every other command module is imported
// lazily to keep startup cheap.
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
