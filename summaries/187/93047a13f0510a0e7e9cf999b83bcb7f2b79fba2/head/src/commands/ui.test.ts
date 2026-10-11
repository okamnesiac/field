import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AudiodClient } from '../audiod/client.js';
import { createSong } from './create.js';
import { init } from './init.js';
import { runUi, staticFile } from './ui.js';

// `field ui` serves the client's build output over loopback HTTP. A request
// path resolves inside that directory or not at all.

describe('static files', () => {
  const dist = join('/pkg', 'ui', 'dist');

  it('serves index.html for the root and files beneath the build output', () => {
    expect(staticFile(dist, '/')).toBe(join(dist, 'index.html'));
    expect(staticFile(dist, '/assets/app.js')).toBe(join(dist, 'assets', 'app.js'));
  });

  it('refuses a path that climbs out, including into a sibling named like dist', () => {
    expect(staticFile(dist, '/../dist-evil/secret')).toBeUndefined();
    expect(staticFile(dist, '/../../etc/passwd')).toBeUndefined();
    expect(staticFile(dist, '/..')).toBeUndefined();
  });
});

describe('starting field ui', () => {
  it('refuses a taken --port before it touches the daemon', async () => {
    // Loading the session replaces whatever the daemon is playing, so a
    // port that cannot be bound has to be found before that, not after.
    const root = mkdtempSync(join(tmpdir(), 'field-ui-port-'));
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const address = taken.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      init({ dir: root, name: 'album' });
      createSong(root, 'creek');
      await expect(runUi(root, 'creek', { port, open: false })).rejects.toThrow(
        `port ${port} is already in use`,
      );
      // No daemon was spawned for this project.
      await expect(AudiodClient.connect(root, { spawnIfNeeded: false })).rejects.toThrow('not running');
    } finally {
      taken.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
