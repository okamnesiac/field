// compileSession's validity gate: the one place a red project meets
// `field play`. The message must carry the diagnostics — "project has
// errors" with the errors withheld was the reported failure.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWavFloat32 } from '../audio/wav.js';
import { daemonBinary } from '../audiod/client.js';
import { buildLabels } from '../commands/build.js';
import { createSong, createTrack } from '../commands/create.js';
import { importAsset } from '../commands/import.js';
import { init } from '../commands/init.js';
import { compileSession } from './live.js';

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

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

// A held solo compiles a filtered copy of the song (model/solo.ts), and a
// track whose soloed spec is already cached freezes. The stem served for
// it must be that soloed one: the files on disk still describe the
// un-soloed track, so anything that reloads them builds the wrong stem.
describe.skipIf(!binary)('compileSession under a solo', () => {
  it('serves a frozen track the stem of its soloed spec', async () => {
    for (const [name, hz] of [['kick', 110], ['hats', 880]] as const) {
      const src = join(root, `${name}.wav`);
      const tone = Float32Array.from({ length: 4800 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / 48000));
      writeWavFloat32(src, 48000, [tone]);
      await importAsset(root, 'opener', src, name);
      createTrack(root, 'opener', name);
      writeFileSync(join(root, `songs/opener/tracks/${name}.yaml`), [`name: ${name}`, 'inputs:', `  - audio: ${name}`, ''].join('\n'));
    }
    createTrack(root, 'opener', 'bed');
    const bed = (muteHats: boolean) =>
      writeFileSync(
        join(root, 'songs/opener/tracks/bed.yaml'),
        ['name: bed', 'inputs:', '  - track: kick', '  - track: hats', ...(muteHats ? ['    mute: true'] : []), ''].join('\n'),
      );
    writeFileSync(join(root, 'songs/opener/tracks/main.yaml'), ['name: main', 'inputs:', '  - track: bed', ''].join('\n'));

    // The kick-only bed is built and cached while hats is muted...
    bed(true);
    const kickOnly = (await buildLabels(root, ['//songs/opener/track:bed'])).find((o) => o.label.endsWith(':bed'))!;
    // ...then hats comes back, and the kick is soloed: the soloed bed is
    // exactly that cached kick-only spec, so bed freezes.
    bed(false);
    const both = (await buildLabels(root, ['//songs/opener/track:bed'])).find((o) => o.label.endsWith(':bed'))!;
    expect(kickOnly.sha256).not.toBe(both.sha256);
    const { session } = await compileSession(root, 'opener', { solo: 'kick' });
    const wire = JSON.stringify(session);
    expect(wire).toContain(kickOnly.sha256);
    expect(wire).not.toContain(both.sha256);
  });
});
