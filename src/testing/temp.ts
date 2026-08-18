import { rmSync } from 'node:fs';

// Removes a test project directory that a daemon may still be exiting
// from. On Windows a directory that is a live process's cwd — or that
// holds its still-open log — cannot be deleted, and the daemon takes a
// few hundred milliseconds to wind down after `quit`; rmSync's own
// maxRetries does not cover every op in the recursive walk, so the
// retry lives out here around the whole removal. POSIX deletes a live
// process's cwd without complaint and returns on the first pass.
export async function removeTempProject(root: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
