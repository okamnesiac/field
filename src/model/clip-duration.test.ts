import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainLabel } from '../commands/build.js';
import { check } from '../commands/check.js';
import { createSong } from '../commands/create.js';
import { init } from '../commands/init.js';

// A clip may omit its duration, meaning the whole source — the same thing
// a placement's omitted duration means about the whole child
// (nested-tracks.md §1.6). It was required on the argument that a clip's
// source is committed content whose length `check` can read; that is true
// of an asset and false of a buildable sound, whose length is exactly as
// unknowable at plan time as a track's.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'field-clip-duration-'));
  init({ dir: root, name: 'test-album' });
  createSong(root, 'creek');
  mkdirSync(join(root, 'songs/creek/sounds'), { recursive: true });
  writeFileSync(
    join(root, 'songs/creek/sounds/blip.yaml'),
    'name: blip\ntype: supercollider\nsource: blip.scd\nseed: 1\nduration: 2\n',
  );
  mkdirSync(join(root, 'shared/instruments'), { recursive: true });
  writeFileSync(join(root, 'shared/instruments/blip.scd'), 'Out.ar(0, Silent.ar(2));\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const track = (name: string, yaml: string) =>
  writeFileSync(join(root, 'songs/creek/tracks', `${name}.yaml`), yaml);

const clip = (extra: string[] = []) =>
  track(
    'bed',
    ['name: bed', 'inputs:', '  - id: hit', '    sound: blip', '    at: 0', ...extra, ''].join(
      '\n',
    ),
  );

const clipsOf = async (label: string) =>
  ((await explainLabel(root, label)).parameters as { clips: Record<string, number>[] }).clips;

describe('a clip with no duration', () => {
  it('is a valid clip, and plans without a window', async () => {
    clip();
    expect((await check(root)).diagnostics).toEqual([]);
    const [only] = await clipsOf('//songs/creek/track:bed');
    // No `duration` key at all, which is how a placed track's open window
    // already reaches the daemon: execute() fills it from the rendered
    // input, so it never enters the action key.
    expect(only).not.toHaveProperty('duration');
    expect(only!.start).toBe(0);
  });

  it('still gets every other clip check', async () => {
    // The trap this test exists for: the loader used to bail out of the
    // whole clip block when the duration did not resolve, and an absent
    // duration resolves to `undefined` by the same path. Collapsing the
    // two would let `duration:` be omitted and quietly take the source
    // check, the id check and the fade check with it.
    track(
      'bed',
      [
        'name: bed',
        'inputs:',
        '  - id: hit',
        '    sound: nonexistent',
        '    at: 0',
        '',
      ].join('\n'),
    );
    const messages = (await check(root)).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toContain('unknown sound "nonexistent"');
  });

  it('is refused when the clip also loops', async () => {
    // A loop tiles a window, so it needs one (clip-looping.md §1). "As
    // long as the source" and "repeat to fill the window" are contrary
    // instructions rather than a default and an override.
    clip(['    loop:', '      enabled: true']);
    const messages = (await check(root)).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toContain('loops but declares no duration');
  });

  it('still reports a duration that fails to resolve', async () => {
    // Absent and unresolvable must stay distinguishable in the other
    // direction too: a musical span on an absolute clip is an error, not
    // an omission.
    clip(['    anchor: absolute', '    duration: [4]']);
    const messages = (await check(root)).diagnostics.map((d) => d.message);
    expect(messages.join('\n')).toContain('musical time on an absolute entry');
  });
});

describe('a clip that declares one', () => {
  it('keeps the window it declared', async () => {
    clip(['    duration: [1]']);
    expect((await check(root)).diagnostics).toEqual([]);
    const [only] = await clipsOf('//songs/creek/track:bed');
    // One bar of the scaffolded 4/4 at 120 bpm is 2.000 s.
    expect(only!.duration).toBe(96000);
  });

  it('plans differently from an open window, so the two cannot share a cache entry', async () => {
    // Compared on the plan rather than the action key: the key is
    // `undefined` until the input has been built, since it hashes the
    // dependency's output. The plan is what the key hashes, so a
    // difference here is the claim.
    clip(['    duration: [1]']);
    const declared = JSON.stringify((await explainLabel(root, '//songs/creek/track:bed')).parameters);
    clip();
    const open = JSON.stringify((await explainLabel(root, '//songs/creek/track:bed')).parameters);
    expect(open).not.toBe(declared);
    expect(declared).toContain('"duration":96000');
    expect(open).not.toContain('"duration"');
  });
});
