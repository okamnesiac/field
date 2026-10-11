import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AudiodClient, daemonBinary } from '../audiod/client.js';
import { createSong, createTrack } from '../commands/create.js';
import { init } from '../commands/init.js';
import { removeTempProject } from '../testing/temp.js';
import { compileSession } from '../graph/live.js';
import { keysInputsFor, routeArmed, type Routing } from './routing.js';

// Playing through the effects (live-supercollider.md chunk 3): an input
// per armed track in the daemon, and the song's session loaded with them.
// FieldOut itself is not needed here, only somewhere it would be, so a
// directory holding an empty FieldOut.scx stands in for the build.

const binary = (() => {
  try {
    return daemonBinary();
  } catch {
    return undefined;
  }
})();

describe.skipIf(!binary || process.platform === 'win32')('routing armed tracks through the daemon', () => {
  let root: string;
  let fieldOut: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-routing-'));
    fieldOut = join(root, 'fieldout');
    mkdirSync(fieldOut);
    writeFileSync(join(fieldOut, 'FieldOut.scx'), '');
    env = { ...process.env, FIELD_FIELDOUT: fieldOut };
    process.env['FIELD_AUDIOD_NULL'] = '1';
    init({ dir: root, name: 'routing' });
    writeFileSync(join(root, 'shared/instruments/pad.scd'), '// a voice\n');
    for (const song of ['creek', 'tall-grass', 'fast']) {
      createSong(root, song);
      createTrack(root, song, 'bass');
      writeFileSync(join(root, `songs/${song}/tracks/bass.yaml`), 'name: bass\ninputs:\n  - record:\n      instrument: pad\n');
      writeFileSync(join(root, `songs/${song}/tracks/main.yaml`), 'name: main\ninputs:\n  - track: bass\n');
    }
    // A song at a rate the null device does not run at, so the daemon
    // converts its delivery.
    writeFileSync(
      join(root, 'songs/fast/song.yaml'),
      'name: fast\nrate: 44100\ntime:\n  tempo:\n    - at: 0\n      bpm: 120\n  meter:\n    - at: 0\n      numerator: 4\n      denominator: 4\n',
    );
  });
  afterEach(async () => {
    try {
      const client = await AudiodClient.connect(root);
      await client.quit();
      client.close();
    } catch {
      // never started
    }
    delete process.env['FIELD_AUDIOD_NULL'];
    await removeTempProject(root);
  });

  const pad = () => join(root, 'shared/instruments/pad.scd');

  it("opens an input for each armed track, loads the song with them, and puts the song back on close", async () => {
    const routed = (await routeArmed(
      [
        { program: pad(), track: 'creek/bass', unheardEffects: [] },
        { program: pad(), unheardEffects: [] },
      ],
      root,
      { env },
    )) as Routing;
    expect(routed.programs).toEqual([pad(), pad()]);
    expect(routed.rings[0]).toBeGreaterThan(0);
    expect(routed.rings[1]).toBeNull();
    expect(routed.fieldOut).toBe(fieldOut);

    const client = await AudiodClient.connect(root);
    try {
      const status = await client.status();
      expect(status).toMatchObject({ live: true, song: 'creek' });
      expect(status.inputs).toEqual([expect.objectContaining({ name: 'keys:creek/bass', ring: routed.rings[0] })]);
      // Another command loading the song, as field play, its watch,
      // field ui, and field record do, compiles the input back in.
      const inputs = await keysInputsFor(client, 'creek');
      expect(inputs).toEqual([{ track: 'bass', input: 'keys:creek/bass' }]);
      expect(await keysInputsFor(client, 'tall-grass')).toEqual([]);
      const { session } = await compileSession(root, 'creek', { inputs });
      await client.session(session);
      expect((await client.status()).inputs).toEqual([expect.objectContaining({ name: 'keys:creek/bass' })]);
      await routed.close();
      const after = await client.status();
      expect(after.inputs).toBeUndefined();
      expect(after).toMatchObject({ live: true, song: 'creek' });
    } finally {
      client.close();
    }
  });

  it('says why it cannot route: tracks in two songs, FieldOut not built, or nothing but instruments', async () => {
    expect(
      await routeArmed(
        [
          { program: pad(), track: 'creek/bass', unheardEffects: [] },
          { program: pad(), track: 'tall-grass/bass', unheardEffects: [] },
        ],
        root,
        { env },
      ),
    ).toEqual({ reason: 'the tracks are in creek and tall-grass, and one session plays one song' });
    expect(
      await routeArmed([{ program: pad(), track: 'creek/bass', unheardEffects: [] }], root, {
        env: { ...process.env, FIELD_FIELDOUT: join(root, 'songs') },
      }),
    ).toEqual({ reason: 'FieldOut is not built: run pnpm build:native' });
    expect(await routeArmed([{ program: pad(), unheardEffects: [] }], root, { env })).toBeUndefined();
  });

  it('plays dry when the daemon converts the song to the device, and leaves no input open', async () => {
    expect(await routeArmed([{ program: pad(), track: 'fast/bass', unheardEffects: [] }], root, { env })).toEqual({
      reason: "the device does not run at the song's 44100 Hz, so the daemon converts it",
    });
    const client = await AudiodClient.connect(root);
    try {
      expect((await client.status()).inputs).toBeUndefined();
    } finally {
      client.close();
    }
  });
});
