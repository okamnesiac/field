import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { staticFile } from './ui.js';

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
