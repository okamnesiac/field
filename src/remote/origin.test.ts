import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../git.js';
import { parseCloneUrl, resolveProjectRemote } from './origin.js';

// The remote is read from Git (remote.md §5 decision 3): origin's host
// gives the API base, origin's path gives the project, FIELD_REMOTE
// replaces the base and nothing else.

describe('parseCloneUrl', () => {
  it('derives the API host from an audiofield git host and the slug from the path', () => {
    expect(parseCloneUrl('https://git.audiofield.io/howlo/chemicals.git')).toEqual({
      slug: { owner: 'howlo', project: 'chemicals' },
      api: 'https://audiofield.io',
    });
    // A trailing .git is optional (audiofield-io.md §3).
    expect(parseCloneUrl('https://git.audiofield.io/howlo/chemicals')).toEqual({
      slug: { owner: 'howlo', project: 'chemicals' },
      api: 'https://audiofield.io',
    });
    // A staging host maps the same way; the scheme and port ride along.
    expect(parseCloneUrl('http://git.localhost:3000/howlo/chemicals')).toEqual({
      slug: { owner: 'howlo', project: 'chemicals' },
      api: 'http://localhost:3000',
    });
  });

  it('gives a slug but no API for hosts Field does not recognize', () => {
    expect(parseCloneUrl('https://github.com/okamnesiac/field.git')).toEqual({
      slug: { owner: 'okamnesiac', project: 'field' },
    });
    expect(parseCloneUrl('git@github.com:okamnesiac/field.git')).toEqual({
      slug: { owner: 'okamnesiac', project: 'field' },
    });
    expect(parseCloneUrl('file:///tmp/remotes/howlo/chemicals.git')).toEqual({
      slug: { owner: 'howlo', project: 'chemicals' },
    });
    expect(parseCloneUrl('/tmp/remotes/howlo/chemicals.git')).toEqual({
      slug: { owner: 'howlo', project: 'chemicals' },
    });
  });

  it('gives no slug for a path with fewer than two segments', () => {
    expect(parseCloneUrl('https://git.audiofield.io/chemicals')).toEqual({ api: 'https://audiofield.io' });
    expect(parseCloneUrl('https://git.audiofield.io/')).toEqual({ api: 'https://audiofield.io' });
  });
});

describe('resolveProjectRemote', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'field-origin-'));
    git(['init', '-q'], { cwd: root });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads origin from the checkout', () => {
    git(['remote', 'add', 'origin', 'https://git.audiofield.io/howlo/chemicals.git'], { cwd: root });
    expect(resolveProjectRemote(root, {})).toEqual({
      kind: 'remote',
      remote: { api: 'https://audiofield.io', owner: 'howlo', project: 'chemicals' },
    });
  });

  it('has no remote without an origin, or with one Field has no API for', () => {
    expect(resolveProjectRemote(root, {})).toMatchObject({ kind: 'none' });
    git(['remote', 'add', 'origin', 'https://github.com/okamnesiac/field.git'], { cwd: root });
    expect(resolveProjectRemote(root, {})).toMatchObject({ kind: 'none', reason: expect.stringContaining('git.<site>') });
  });

  it('lets FIELD_REMOTE supply the API base for any origin with a slug', () => {
    // How a test points a checkout cloned from a bare repository on disk
    // at an in-process stub, and how anyone points at a staging site.
    git(['remote', 'add', 'origin', '/tmp/remotes/howlo/chemicals.git'], { cwd: root });
    expect(resolveProjectRemote(root, { FIELD_REMOTE: 'http://127.0.0.1:9/' })).toEqual({
      kind: 'remote',
      remote: { api: 'http://127.0.0.1:9', owner: 'howlo', project: 'chemicals' },
    });
    // ...but not for an origin with no slug to name the project.
    git(['remote', 'set-url', 'origin', '/bare.git'], { cwd: root });
    expect(resolveProjectRemote(root, { FIELD_REMOTE: 'http://127.0.0.1:9' })).toMatchObject({ kind: 'none' });
  });

  it('turns reads off for FIELD_REMOTE=off', () => {
    git(['remote', 'add', 'origin', 'https://git.audiofield.io/howlo/chemicals.git'], { cwd: root });
    expect(resolveProjectRemote(root, { FIELD_REMOTE: 'off' })).toEqual({ kind: 'off' });
  });
});
