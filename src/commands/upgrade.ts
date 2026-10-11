import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

// `field upgrade [target]`: run the installer of the checkout this command
// was built from, with the same target, output, and exit status
// (install.md §2.5). Installing belongs to install.sh, which knows how to
// build and link each piece, so nothing here decides what an upgrade is.
// It finds the installer the way the daemon and the keymaps are found:
// beside the package this file was loaded from, which for a linked
// checkout is the checkout itself.

// Two levels up from src/commands/ and from dist/commands/ alike.
export function installerPath(): string {
  return fileURLToPath(new URL('../../install.sh', import.meta.url));
}

export interface UpgradeDeps {
  installer?: string | undefined;
  run?: ((script: string, args: string[]) => number) | undefined;
  err?: ((line: string) => void) | undefined;
  platform?: NodeJS.Platform | undefined;
}

export function upgrade(target: string | undefined, deps: UpgradeDeps = {}): number {
  // install.sh is bash and builds with the POSIX toolchain, so on Windows
  // this would hand a script to whatever `bash` resolves to, which may be
  // WSL's and not the Windows side at all (install.md §7.6).
  if ((deps.platform ?? process.platform) === 'win32') {
    throw new Error(
      'field upgrade runs install.sh, which does not support Windows yet — in the field checkout, run ' +
        'pnpm install --frozen-lockfile, pnpm build, pnpm build:ui, and pnpm build:native',
    );
  }
  const installer = deps.installer ?? installerPath();
  if (!existsSync(installer)) {
    throw new Error(`cannot upgrade: ${installer} does not exist, so this field was not installed from a checkout`);
  }
  const args = target === undefined ? [] : [target];
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  // The command it runs, as you would type it, so the output that follows
  // has a name and the step can be repeated by hand.
  err(`+ ${[installer, ...args].map(displayQuote).join(' ')}`);
  return (deps.run ?? runInstaller)(installer, args);
}

// Through bash rather than the script's own execute bit, which a checkout
// with core.fileMode off, or one copied without modes, does not keep.
function runInstaller(script: string, args: string[]): number {
  const result = spawnSync('bash', [script, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal !== null) return 128 + (constants.signals[result.signal] ?? 0);
  return result.status ?? 1;
}

function displayQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
