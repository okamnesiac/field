import { join, relative } from 'node:path';

// Where a daemon's socket is, expressed so `connect()` will accept it.
//
// `sun_path` is 104 bytes on macOS and 108 on Linux, and Node's connect()
// is subject to the same limit as bind(). A cwd-relative path keeps it
// short whenever the CLI runs inside the project, which it always does —
// requireRoot found the manifest by walking upward.
//
// One function because it was two, in audiod/client.ts and
// workers/client.ts, and `field --version` was about to make it three by
// omission: probing with a bare absolute path would report a running
// daemon as not running on any deep enough checkout, which is precisely
// the wrong answer from a command whose job is saying what is running
// (#70 review). A rule kept in step by hand is a rule that drifts —
// the same argument that moved SETUP_SPECS in #67.
export function socketPathFor(root: string, socketRelative: string): string {
  const absolute = join(root, socketRelative);
  const rel = relative(process.cwd(), absolute);
  return rel.length < absolute.length ? rel : absolute;
}
