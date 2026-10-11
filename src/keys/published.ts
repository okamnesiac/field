import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { chasedControllerSchema, type ChasedController } from '../audiod/protocol.js';

// What `field keys` has sent, for `field record` (instrument-knobs.md
// §2.8): a take records only what arrives after it starts, so the daemon
// starts it from the controllers `field keys` published, and a take
// renders with the knobs where you left them.

export const PUBLISHED_PATH = join('.field', 'keys.json');

const publishedSchema = z.object({
  pid: z.number().int().positive(),
  controllers: z.array(chasedControllerSchema),
});

// Written to a temporary file and renamed over the last, so a reader
// never sees half of it.
export function publishControllers(root: string, controllers: ChasedController[], pid = process.pid): void {
  const path = join(root, PUBLISHED_PATH);
  mkdirSync(join(root, '.field'), { recursive: true });
  writeFileSync(`${path}.${pid}.tmp`, JSON.stringify({ pid, controllers }));
  renameSync(`${path}.${pid}.tmp`, path);
}

// Removes the file when this process wrote it, so a `field keys` that
// quits leaves another one's alone.
export function unpublishControllers(root: string, pid = process.pid): void {
  if (readPublished(root)?.pid === pid) rmSync(join(root, PUBLISHED_PATH), { force: true });
}

// The controllers to start a MIDI take from: none unless the daemon
// chases them, and none unless the `field keys` that published them is
// still running.
export function controllersToChase(root: string, daemonChases: boolean): ChasedController[] {
  if (!daemonChases) return [];
  const published = readPublished(root);
  return published !== undefined && running(published.pid) ? published.controllers : [];
}

function readPublished(root: string): z.infer<typeof publishedSchema> | undefined {
  try {
    return publishedSchema.parse(JSON.parse(readFileSync(join(root, PUBLISHED_PATH), 'utf8')));
  } catch {
    return undefined;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process runs, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
