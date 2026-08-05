import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_SAMPLE_RATE, PROJECT_MANIFEST } from '../constants.js';
import { isSlug } from '../ids.js';
import { projectOrder, projectSchema } from '../schema/schemas.js';
import { stringifyCanonical } from '../yaml/emit.js';

// Audio and MIDI assets ride Git LFS; manifests stay plain text
// (project-model.md "Assets").
const LFS_PATTERNS = ['*.wav', '*.aif', '*.aiff', '*.flac', '*.mp3', '*.m4a', '*.caf'];

const IGNORE_ENTRIES = ['.bloom/', '.DS_Store'];

export interface InitOptions {
  dir: string;
  name?: string;
  sampleRate?: number;
}

export function init(options: InitOptions): string {
  const root = resolve(options.dir);
  const manifestPath = join(root, PROJECT_MANIFEST);
  if (existsSync(manifestPath)) {
    throw new Error(`already a Bloom project: ${manifestPath}`);
  }

  const name = options.name ?? basename(root);
  if (!isSlug(name)) {
    throw new Error(`project name "${name}" must be a lowercase-slug (use --name)`);
  }

  const manifest = projectSchema.parse({
    bloom: 1,
    name,
    sample_rate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
  });

  mkdirSync(root, { recursive: true });
  for (const dir of ['songs', 'shared/instruments', 'shared/loops', 'shared/samples', 'shared/sc']) {
    mkdirSync(join(root, dir), { recursive: true });
    // Git can't track an empty directory; .gitkeep makes the project's
    // shape survive clone.
    writeFileSync(join(root, dir, '.gitkeep'), '');
  }
  writeFileSync(manifestPath, stringifyCanonical(manifest, projectOrder));

  const gitignore = join(root, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = IGNORE_ENTRIES.filter((e) => !existing.split('\n').includes(e));
  if (missing.length > 0) {
    appendFileSync(gitignore, (existing.endsWith('\n') || existing === '' ? '' : '\n') + missing.join('\n') + '\n');
  }

  const gitattributes = join(root, '.gitattributes');
  if (!existsSync(gitattributes)) {
    writeFileSync(
      gitattributes,
      LFS_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`).join('\n') + '\n',
    );
  }

  if (!existsSync(join(root, '.git'))) {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  }
  try {
    execFileSync('git', ['lfs', 'install', '--local'], { cwd: root, stdio: 'ignore' });
  } catch {
    process.stderr.write('warning: git-lfs not available; audio assets will not be tracked by LFS\n');
  }

  return root;
}
