import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bakes the build's git identity into dist/ so `field --version` reports
// what the artifact was BUILT from, not where the checkout happens to
// sit when the command runs — the two drift the moment a branch is
// switched without a rebuild, and --version exists to resolve exactly
// that confusion. Runs as the second half of `pnpm build`.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
};

const commit = git(['rev-parse', '--short', 'HEAD']);
const status = git(['status', '--porcelain']);
const info =
  commit === undefined
    ? {}
    : {
        commit,
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        dirtyFiles: status === undefined ? undefined : status.split('\n').filter((l) => l.trim()).length,
      };
writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
process.stdout.write(`stamped dist/build-info.json (${info.commit ?? 'not a git checkout'})\n`);
