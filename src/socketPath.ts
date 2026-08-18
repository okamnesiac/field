import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

// Where a daemon's socket is, expressed so `connect()` will accept it.
//
// POSIX: `sun_path` is 104 bytes on macOS and 108 on Linux, and Node's
// connect() is subject to the same limit as bind(). A cwd-relative path
// keeps it short whenever the CLI runs inside the project, which it
// always does — requireRoot found the manifest by walking upward.
//
// Windows: the local domain is named pipes, which are not filesystem
// paths and have no such limit — the same function answers a different
// question per platform (windows-portability.md §2.3). The name is
// derived from the resolved project root plus the relative socket path,
// lowercased because NTFS paths compare case-insensitively and two
// spellings of one root must not mint two daemons. The daemon binds
// whatever --socket says, so client and daemon agree by construction.
//
// One function because it was two, in audiod/client.ts and
// workers/client.ts, and `field --version` was about to make it three by
// omission: probing with a bare absolute path would report a running
// daemon as not running on any deep enough checkout, which is precisely
// the wrong answer from a command whose job is saying what is running
// (#70 review). A rule kept in step by hand is a rule that drifts —
// the same argument that moved SETUP_SPECS in #67.
export function socketPathFor(root: string, socketRelative: string): string {
  if (process.platform === 'win32') {
    const key = createHash('sha256')
      .update(`${resolve(root).toLowerCase()}|${socketRelative}`)
      .digest('hex')
      .slice(0, 24);
    return `\\\\.\\pipe\\field-${key}`;
  }
  const absolute = join(root, socketRelative);
  const rel = relative(process.cwd(), absolute);
  return rel.length < absolute.length ? rel : absolute;
}
