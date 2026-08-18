import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_SAMPLE_RATE, PROJECT_MANIFEST } from '../constants.js';
import { isSlug } from '../ids.js';
import { projectOrder, projectSchema } from '../schema/index.js';
import { stringifyCanonical } from '../yaml/emit.js';

// Audio and MIDI assets ride Git LFS; manifests stay plain text
// (project-model.md "Assets").
const LFS_PATTERNS = ['*.wav', '*.aif', '*.aiff', '*.flac', '*.mp3', '*.m4a', '*.caf'];

// The whole .gitattributes a new project gets. The LF rule is first and
// the binary rules override it (last match wins): field hashes
// working-tree bytes — asset pins, .scd action keys, check's byte-wise
// formatting gate — so a checkout that rewrote line endings would change
// every one of those answers while `git status` stayed clean
// (windows-portability.md §1.1). Git for Windows defaults
// core.autocrlf=true, which does exactly that to any project that does
// not pin LF itself. *.state is captured plugin state, named by its own
// sha256 and refused if the bytes move — never a conversion candidate.
const GITATTRIBUTES = [
  '# Text checks out LF everywhere: field hashes file bytes as they sit',
  '# on disk, so line endings are pinned rather than platform-dependent.',
  '# Binary rules below override (last match wins); audio and plugin',
  '# state are never touched.',
  '* text=auto eol=lf',
  '',
  ...LFS_PATTERNS.map((p) => `${p} filter=lfs diff=lfs merge=lfs -text`),
  '*.state binary',
  '',
].join('\n');

const IGNORE_ENTRIES = ['.field/', '.DS_Store'];

export interface InitOptions {
  dir: string;
  name?: string;
  sampleRate?: number;
}

export function init(options: InitOptions): string {
  const root = resolve(options.dir);
  const manifestPath = join(root, PROJECT_MANIFEST);
  if (existsSync(manifestPath)) {
    throw new Error(`already a Field project: ${manifestPath}`);
  }

  const name = options.name ?? basename(root);
  if (!isSlug(name)) {
    throw new Error(`project name "${name}" must be a lowercase-slug (use --name)`);
  }

  const manifest = projectSchema.parse({
    field: 1,
    name,
    sample_rate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
  });

  mkdirSync(root, { recursive: true });
  // shared/'s three shelves split by contract (project-layout.md §1.1
  // as amended by §4): instruments make sound (.scd programs, model
  // defs, later AU — however they are invoked), samples are committed
  // sound that just is, and plugins change sound.
  for (const dir of ['songs', 'shared/instruments', 'shared/samples', 'shared/plugins']) {
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
    writeFileSync(gitattributes, GITATTRIBUTES);
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
