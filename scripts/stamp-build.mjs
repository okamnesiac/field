import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bakes the build's git identity into dist/ so `field --version` reports
// what the artifact was BUILT from, not where the checkout happens to
// sit when the command runs — the two drift the moment a branch is
// switched without a rebuild, and --version exists to resolve exactly
// that confusion. Runs on both sides of `pnpm build`: `--clear` first,
// so a build that fails anywhere — tsc, or this script — leaves NO
// stamp rather than an old one describing dist it no longer matches
// (Bugbot on #121); the write only after everything succeeded.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = join(root, 'dist', 'build-info.json');
if (process.argv.includes('--clear')) {
  rmSync(stampPath, { force: true });
  process.exit(0);
}
const git = (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

// Full sha: git lengthens --short prefixes as a repo grows, so equal
// objects can compare unequal as strings (Bugbot on #121). Display
// shortening is the formatter's, at read time.
const commit = git(['rev-parse', 'HEAD']);
const status = git(['status', '--porcelain']);
const info =
  commit === undefined
    ? {}
    : {
        commit,
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        dirtyFiles: status === undefined ? undefined : status.split('\n').filter((l) => l.trim()).length,
      };
writeFileSync(stampPath, JSON.stringify(info, null, 2) + '\n');
process.stdout.write(`stamped dist/build-info.json (${info.commit?.slice(0, 7) ?? 'not a git checkout'})\n`);
