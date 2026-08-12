// compileSession's validity gate: the one place a red project meets
// `field play`. The message must carry the diagnostics — "project has
// errors" with the errors withheld was the reported failure.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';
import { compileSession } from './live.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-live-gate-test-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'opener');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('compileSession validity gate', () => {
  it('names the diagnostics in the refusal, not just that they exist', async () => {
    writeFileSync(
      join(root, 'songs/opener/tracks/lead.yaml'),
      [
        'name: lead',
        'inputs:',
        '  - id: k1',
        '    audio: missing-thing',
        '  - id: k1',
        '    audio: missing-thing',
        '',
      ].join('\n'),
    );
    await expect(compileSession(root, 'opener')).rejects.toThrow(
      /project has errors \(field check\):\n[\s\S]*duplicate input id "k1"/,
    );
  });
});
