import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// SHA-256 everywhere (project-core.md §3.5): asset hashes equal Git LFS
// OIDs, so the store, the pointer, and the build cache share one identifier.
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
