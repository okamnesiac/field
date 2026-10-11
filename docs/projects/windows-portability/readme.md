---
status: in-progress
priority: now
---

# Plan: Windows portability — the checkout, the socket, and the last bits

**Goal:** field builds, checks, plays and **live-renders** on Windows, so
that the realtime engine — which has no platform-bound code in it at all —
stops being unreachable from the platform it happens not to be developed
on. Assessment written 2026-08-12 by reading `main` at `766e532`; work
began 2026-08-16 with chunk 1, and the flip to `in-progress` rode that diff,
answering §2's decisions as it went.

This is scoped to the **core**: the CLI, the build graph, and the daemon
including live evaluation. The generative Python workers and SuperCollider
are deliberately out (§4). Windows was written down as an explicit V1
non-goal in [docs/README.md](../../README.md) "V1 platform scope" until
chunk 1: per §2.4 that diff moved it, with Linux, into the
build-and-test-targets paragraph there — §3 says what the claim is and
is not.

The headline, because it is not what you would guess: **live rendering is
not the hard part.** `live.cpp`, `render.cpp`, `plan.cpp` and every file
in `dsp/` contain no platform branches whatsoever — `grep -n -E
'#include <(sys/|unistd|fcntl|signal)|JUCE_MAC|__APPLE__' ` over them
returns nothing. The daemon's hot-plug fallback already exists from
[linux-portability.md](../linux-portability/readme.md) decision 2, and JUCE gives
WASAPI for free. What stands between Windows and the live graph is the
**control socket**, and before that, the **checkout itself**.

## 1 Findings

Ordered by what blocks what, not by size. The first one blocks measuring
any of the others.

### 1.1 The checkout corrupts content hashes before any code runs

As assessed (2026-08-12), this repository had **no `.gitattributes` at
all** — chunk 1 is the file that ended this finding, and the measurements
below are from before it. Git for Windows defaults to
`core.autocrlf=true` (it is set on the assessment machine), so a fresh
Windows clone rewrote every text file to CRLF on the way to disk.

Measured, not assumed, on `examples/bloom/shared/instruments/creek-kit.scd`:

```text
on-disk size: 2323 bytes, CR bytes present: 71
sha256 on disk : 197c273b353c35ce3a7ecc00774f3aff9553b51daa33522efa7495fb2b496d46
sha256 as LF   : 49f970a7db30fc972b8ef060e55e3ae2991107137fbf9dd1a6ebb88e59dcea61
```

`git status` is **clean** throughout, because git compares normalized
content and so hides the difference completely. field does not: it hashes
what is on disk.

Four things break — three silently, one loudly:

- **`sc-render`'s action key includes the program's content hash.** Every
  SuperCollider render on Windows keys differently from the same render on
  macOS, so the cache never shares across platforms — and
  [render-pipeline.md](../render-pipeline/readme.md) §4's byte-identical claim
  cannot even be *tested* cross-platform, because the inputs differ before
  the DSP is reached.
- **`field check`'s canonical formatting check is byte-wise.** A
  CRLF working tree is not canonical.
- **Asset pins are content hashes** of committed files
  (`assets.yaml`'s `sha256`), and the LFS OID is the same number.
- **Plugin state blobs are hashed at render time**, and this consumer
  refuses where the other three degrade: `toPluginWire` throws when
  `shared/plugins/` bytes stop hashing to their filename (minjudd's
  grep on #154). Whether CRLF can actually reach a `.state` blob
  depends on git's binary heuristic sparing it — a NUL-byte accident
  rather than a guarantee, which is exactly the dependence chunk 1
  exists to end.

The fix was one committed file, landed first because it is the
instrument every other measurement depends on. It was a file to be
written and verified, not copied from anywhere: the standalone
sample-project repo's `.gitattributes` — seven LFS lines, each ending
`-text` — protected the audio binaries and nothing else, so every text
file in that tree stayed exposed to `core.autocrlf`, and no commit in
the surviving clone's history ever carried `* text=auto eol=lf`
(minjudd traced that clone on #154 — the deleted upstream can hide
nothing reachable; the precedent this section previously claimed does not
exist, and the file that does exist solves the adjacent problem). The
shape chunk 1 wrote is `* text=auto eol=lf` with per-extension binary
overrides for `.wav/.aif/.aiff/.flac/.mp3/.m4a/.caf` **and `.state`**
— the loud consumer above falls through to the binary heuristic
without it, and neither file type existed in the tree (minjudd on
#154), so the rule is written before the first blob arrives to
exercise it — last-match-wins so audio and captured plugin state are
never touched. Its proof is §1.1's measurement re-run against a real
Windows clone, not a provenance story: the chunk 1 pull request carries
that transcript — 0 CR bytes across the clone, `creek-kit.scd` back at
its committed hash — and #157's review reproduced it independently,
including the `.state` override holding against a CRLF blob with no NUL
bytes. Until chunk 1, the engine repository had never had a
`.gitattributes` at all: when the sample project moved in-tree
([bloom-in-tree.md](../bloom-in-tree/readme.md)) not even the LFS lines
came with it.

This is not only a Windows concern, which is the argument for landing it
regardless of whether the rest of this plan is ever built: it makes the
checkout byte-defined on every platform rather than dependent on each
contributor's git configuration.

### 1.2 The control socket is the one real port

`native/audiod/src/server.cpp` is POSIX by hand and says so —
`server.h:15`: "JUCE's StreamingSocket is TCP-only, so the AF_UNIX
plumbing is POSIX by hand". Concretely it uses `<sys/un.h>` and
`sockaddr_un`, `<sys/socket.h>` (`socket`/`bind`/`listen`/`accept`/
`shutdown`), `<sys/file.h>` (`flock`), `<fcntl.h>`, `<unistd.h>`
(`read`/`close`/`unlink`), and raw `int` file descriptors throughout,
including in `Connection::fd`.

The client side is blocked symmetrically and for a different reason:
`src/audiod/client.ts:109` calls `createConnection(path)` with
`.field/audiod.sock`, and **Node implements the local domain on Windows as
named pipes only** — a path must live under `\\.\pipe\`. So neither end
works, and they cannot be fixed independently.

Everything the socket fronts is already portable. The `#if JUCE_MAC`
count in the daemon is six, in two files, all in `player.{h,cpp}`, and
`player.h:46`'s `hardwareListenersAvailable` is already `false` off-macOS
with the heartbeat rescan standing in — that is
[linux-portability.md](../linux-portability/readme.md) decision 2 working as
designed on a platform it was not written for.

Two candidate transports, and this is the plan's central decision (§2.1):

- **Named pipes.** `CreateNamedPipe`/`ConnectNamedPipe` with overlapped
  I/O; Node connects to `\\.\pipe\…` natively. The single-owner guarantee
  that `flock` provides today comes free from
  `FILE_FLAG_FIRST_PIPE_INSTANCE`, and pipes take ACLs, so the permission
  model matches the 0600 Unix socket. The cost is a genuinely different
  accept loop: HANDLEs rather than fds, no `accept()`, and no
  `shutdown(fd, SHUT_RD)` — which `Server::beginShutdown` depends on to
  drain readers without deadlocking against a `MessageManagerLock`
  (`server.h:33`, the fix from #12 review). That drain protocol needs a
  Windows spelling, probably `CancelIoEx`.
- **Loopback TCP with a port file.** JUCE's `StreamingSocket` is already
  in the daemon's dependency set and is TCP-only, which is the very
  reason the hand-rolled AF_UNIX code exists; Node connects to a port
  trivially. Far less code. The costs are real though: a loopback port is
  a standing surface any local process can connect to, where the Unix
  socket is mode 0600, and with no `flock` the single-owner guarantee
  needs its own port-file staleness story — which is precisely the race
  #12 review closed by choosing `flock` over a connect probe.

Either way the honest shape is a small `Transport` seam.
[linux-portability.md](../linux-portability/readme.md) decision 2 rejected exactly
that instinct — "fourteen lines do not earn an abstraction" — and was
right about fourteen lines of hot-plug. This is a different quantity:
roughly 150 lines of `server.cpp` plus the client, with three platforms'
semantics behind it. Reversing that instinct here should be recorded as a
decision with the earlier one cited, not done quietly.

### 1.3 SIGPIPE does not exist on Windows

`main.cpp:306` — `std::signal (SIGPIPE, SIG_IGN)`, under a 25-line comment
beginning "This is the whole mechanism, on every platform". It needs a
`#if !defined(_WIN32)` guard, and that comment then becomes false and has
to be amended rather than left to rot: it is load-bearing documentation of
a real cross-thread race in `Server::send` (the flag is read on one thread
and cleared on another), and it already records that the race is not
covered by a test because provoking it means winning a race by luck.

On Windows a write to a broken pipe returns an error rather than raising,
so the guarantee holds by a different mechanism — which is exactly what
the amended comment should say.

### 1.4 MSVC threatens the byte-identical render claim

`CMakeLists.txt` disables FMA contraction with `-ffp-contract=off`, gated
to `AppleClang`, `Clang` and `GNU`. MSVC is not in that list and has no
flag by that spelling — but the risk is not the one that gate suggests:
since Visual Studio 2022, the default `/fp:precise` generates **no
contractions**, and contraction is an explicit opt-in spelled
`/fp:contract` (no `/fp:contract-` exists; only `except` takes the
minus). The compiler that could contract silently under `/fp:precise` is
pre-VS 2022 MSVC, which has no contract switch at all — so the FMA guard
on MSVC is a toolchain floor, not a flag. The live exposure on a current
MSVC is the **unmeasured third libm**: render-pipeline.md §4 measured
Apple libm and glibc byte-identical, the UCRT has never been in that
comparison, and `clang-cl` does not dodge it because it links the same
UCRT. Left unmeasured, a Windows build can differ from macOS and Linux
in the last bits — which is the one thing
[render-pipeline.md](../render-pipeline/readme.md) §4 promises it will not.

Two routes: pin the VS 2022 floor and hold the documented default, or
build with `clang-cl` and reuse the flag that already exists — and either
way this is the one finding in this document that must be
**measured rather than reasoned about**; the cross-platform byte
comparison from [render-pipeline.md](../render-pipeline/readme.md) chunk 6 is the
instrument, and it needs a Windows build to run against, exactly as it
needed a Linux one.

### 1.5 The daemon binary is resolved by a POSIX-shaped path

`src/audiod/client.ts:43` hardcodes
`native/audiod/build/field-audiod_artefacts/Release/field-audiod`. On
Windows the artefact is `field-audiod.exe`, and MSVC is a **multi-config
generator**, so `pnpm build:native`'s `-DCMAKE_BUILD_TYPE=Release` is
ignored at configure time — the configuration is chosen at build time with
`--config Release`. Both the suffix and the build script need fixing.

It is one fix rather than three: `src/audio/render-daemon.ts:6` and
`src/audio/plugins.ts` both resolve the binary through the same
`daemonBinary()`.

### 1.6 `afplay` has no Windows answer, and probably should not get one

`src/cli.ts:416` shells to `afplay`, described in its own comment as "the
retiring fallback for machines without the built daemon: playback through
afplay, no transport, no --from".

Since [realtime.md](../realtime/readme.md) shipped, `field play` *is* live
evaluation in the daemon. Inventing a PowerShell `SoundPlayer` path that
supports neither transport nor `--from` would add a second, worse
playback path to keep alive on the platform with the least coverage. The
likelier right answer is that Windows has **no fallback** and `field play`
fails with "build the daemon" — but that is a decision (§2.2), not a port.

### 1.7 Node 24 is a prerequisite, not a port

`.nvmrc` says `24` and `package.json` `engines` says `>=24`. The
assessment machine has **v20.20.2**, with no `nvm`, `fnm` or `volta`
installed. CMake 3.25.2 satisfies the `cmake_minimum_required(3.24)`, and
Visual Studio Community 2022 is present. `uv` and `sclang` are absent,
which only matters for §4.

## 2 Decisions (DECIDED, 2026-08-16)

Written as open questions while the plan was `draft`; the chunk 1 diff
flipped it to `in-progress` and answered them, per the convention that the
change making the readiness claim answers for what is still open.

1. **Named pipes** for the control socket (§1.2), not loopback TCP. The
   single-owner guarantee that `flock` provides today comes free from
   `FILE_FLAG_FIRST_PIPE_INSTANCE`, pipes take ACLs so the permission
   model matches the 0600 Unix socket, and a per-project daemon that
   lives for hours is the wrong place to open a standing local port any
   process can connect to. Rejected: **loopback TCP with a port file** —
   far less code, since JUCE's `StreamingSocket` is already in the
   dependency set, but the port-file staleness story reopens exactly the
   race #12 review closed by choosing `flock` over a connect probe. The
   seam is the same either way, so this is reversible at the cost of one
   file if the pipe accept loop turns out worse than expected.
2. **`field play` gets no non-daemon fallback on Windows** (§1.6). Since
   [realtime.md](../realtime/readme.md) shipped, `field play` *is* live evaluation
   in the daemon; a `SoundPlayer`-shaped fallback with no transport and
   no `--from` would be a second, worse playback path kept alive on the
   platform with the least coverage. Without the daemon built, `field
   play` fails with "build the daemon", which is the honest answer.

   **Amended 2026-08-18: the refusal covers every non-macOS platform,
   not Windows alone.** #162's review found the CLI manual describing a
   deliberate macOS-only fallback while the guard was win32-only —
   Linux without a built daemon still spawned `afplay` and died with
   ENOENT naming a macOS binary. The reasoning here was never about
   Windows: `field play` is live evaluation since realtime.md, `afplay`
   is dead code off macOS by definition, and the guard is the
   difference between the build hint and a confusing error. Linux had
   no plan recording the call
   ([linux-portability.md](../linux-portability/readme.md) predates the
   fallback question), so this amendment is where it lives.
3. **`socketPathFor` grows a platform branch, in the same function.**
   `src/socketPath.ts` exists to keep the bound path inside `sun_path`'s
   104 bytes by returning a cwd-relative path; named pipes have no such
   limit and are not filesystem paths at all, so on Windows the function
   returns a pipe name derived from the project root instead — one
   function answering a different question per platform, which its
   comment must then say.
4. **The [docs/README.md](../../README.md) "V1 platform scope" amendment
   rode the chunk 1 diff** — this plan's own rule was "until that line
   moves, this plan stays `draft`", so the flip and the line move are one
   change by construction. The framing reuses
   [linux-portability.md](../linux-portability/readme.md) decision 5:
   Windows as a build-and-test-and-play target, not a second product
   platform.

## 3 Definition of done

`pnpm typecheck`, `pnpm build` and `pnpm test` pass on Windows; the daemon
builds with MSVC and its protocol tests pass in null-output mode;
`cd examples/bloom && node ../../dist/cli.js check` passes on a fresh
Windows clone; `field play` live-renders a session through WASAPI with the
transport working from a second terminal; and a Windows render is
byte-identical to macOS and Linux for the built-in tier, or the gap is
measured and written down.

Not in scope for done: AU hosting, which cannot exist on Windows (§4);
and any claim that Windows is a supported product platform.

## 4 Explicitly out of scope

Recorded so the next reader does not re-derive it.

- **AU hosting is impossible on Windows.** Audio Units is an Apple format
  with no Windows implementation. The code already knows:
  `src/audio/plugins.ts:71` scans `['vst3']` off-Darwin, `CMakeLists.txt`
  guards `JUCE_PLUGINHOST_AU` behind `$<PLATFORM_ID:Darwin>` with a
  comment that defining it elsewhere is an error, and `hosting.cpp:33`
  guards the implementation. **VST3 hosting is unaffected** and the
  vendors ship VST3 on Windows. `examples/bloom` pins no plugins at all,
  so nothing in the repository hits this today; only a session whose YAML
  says `au: aufx/…` would, and it would need a `vst3:` pin.
- **The generative Python workers.**
  `python/worker/src/field_worker/server.py:129` binds `socket.AF_UNIX`.
  Whether CPython exposes `AF_UNIX` on Windows is **unverified here** and
  should be checked rather than assumed — historically it has not, though
  the OS has supported it since Windows 10 1803. It matters less than it
  looks: the client end is Node
  (`src/workers/client.ts` uses `createConnection`), so §1.2's named-pipe
  constraint applies to ACE and voice whatever CPython does, and they need
  the same transport decision, separately. Also
  `src/workers/client.ts`'s installed-probe is already half-ported: it
  picks `Scripts` over `bin` on win32 and joins `spec.script` bare, so
  the `.exe` suffix uv's console shims carry is the one missing piece.
  It advises `brew install uv` when uv is missing. Encouragingly, `python/aced/uv.lock` already carries win32
  CUDA wheels, `triton-windows` and a Windows `flash-attn`, so somebody
  has been here before.
- **SuperCollider**, which is nearly free whenever it is wanted:
  `src/generators/supercollider.ts` tries `sclang` on PATH first and
  honours `FIELD_SCLANG`; only the `/Applications/SuperCollider.app/…`
  fallback is macOS-shaped, and it is a fallback. Note that `field build`
  on `examples/bloom` needs it, which is why CI runs `check` and not
  `build`.

## 5 Chunks

1. **`.gitattributes`** (§1.1). One committed file. Lands first because
   every later measurement depends on the checkout being byte-defined,
   and it is worth landing even if nothing else here is built.
   **Landed** (2026-08-16, the diff that carries this line): proof per
   §1.1 — a fresh clone on a Windows machine with `core.autocrlf=true`
   checks out 0 CR bytes and `creek-kit.scd` at its committed hash.
2. **Build and paths** (§1.5, §1.3). MSVC compiles the daemon: the
   SIGPIPE guard, the `.exe` suffix, multi-config `--config Release` in
   `build:native`. Ends at a real milestone with no socket work at all —
   `field-audiod --render` is spawned by `render-daemon.ts`, and
   `--render-live` directly by the tests that exercise it — both plain
   subprocess runs of the compiled binary, no socket — so **the whole
   offline render path works** once the binary exists.

   **Amended on implementation (2026-08-17).** The first red run found
   the largest Windows defect in a place this plan never looked, because
   the assessment grepped for includes and APIs rather than for
   separator leaks: label pkgs derive from `song.dir`, which was raw
   `relative()` output — `songs\creek` on Windows — so **no typed label
   or pattern could ever match** and ~70 tests failed with "no such
   label". The fix states an invariant the model half-enforced already
   (its schemas reject `\` in YAML paths): project-relative paths are
   slash-separated wherever they are *data* — `song.dir`, diagnostics,
   the session JSON handed to the daemon, `projectRelative`'s output —
   and native only where they are genuinely local (absolute paths,
   `BuildOutcome.outputPath`). Also discovered, all small: `pnpm` is a
   `.cmd` shim `execFile` cannot spawn (the one test that shells it gets
   `shell` on win32); the stub worker is a shebang script Windows cannot
   exec, so a `.js`/`.mjs` interpreter override now runs through
   `process.execPath` (more hermetic everywhere); a test helper built
   `.venv/bin` where the probe reads `.venv/Scripts`; and four path
   assertions, two in `watch.test.ts` and two in `build.test.ts`,
   compared native paths against `/`-joined strings. The
   `server.cpp` chunk-4 stub earns its place here rather than there:
   without it the binary does not link, and chunk 2's milestone is the
   binary. Transport-bound tests (fake daemons on `.sock` paths, the
   stub worker's AF_UNIX serve, two `#!/bin/sh` sclang fakes) are
   guarded per test with the reason beside them, decision-4-of-
   linux-portability style — 9 in `version.test.ts` naming chunk 4; 21
   in `generate.test.ts` plus three describes in `aced`/`voiced` naming
   the workers' §4, which is not chunk 4; 2 in `build.test.ts` naming
   nothing, since only a second stub dialect removes them (#158 review
   corrected an earlier version of this sentence).

   **Amended again when the compiler arrived (2026-08-18).** MSVC found
   two defects in the daemon that no amount of reading had: `M_PI` is
   not standard C++ (glibc and Apple's libc++ hand it out, MSVC does
   not), used six times across `biquad.cpp`, `mixdown.cpp` and
   `resample.cpp` — now `std::numbers::pi`, the same double bit for
   bit; and `LiveSession::Track`'s *implicit* copy constructor, which
   clang never instantiates because nothing uses it, but MSVC's STL
   compiles eagerly and rejects over the chain's `unique_ptr`s — Track
   is now explicitly move-only, which is what it always was. One more
   guard family joined at verification: the serve-mode describes
   (`audiod/client`, `play-daemon`, plugin-hosting's live chains, and
   four socket tests in `live-session`) run now that the binary exists
   and refuse at the chunk-2 stub, so they skip on win32 naming chunk 4
   — while `--render`, `--render-live` and `--scan` subprocess tests
   run and pass. Verified in batches on the Windows machine: every
   test file passes; `field-dsp-check` reports all block partitions
   bit-identical, resampler included, which is chunk 3's first good
   omen. The one caveat worth keeping: under full parallel load this
   particular machine (OneDrive checkout, Defender re-scanning the
   fresh exe per spawn) drops an occasional spawn — every such failure
   re-ran green in isolation, and a CI runner shares none of those
   conditions.

   **Amended when recording arrived from `main` (2026-10-10).** The
   merge of recording chunks 1 to 4 (#166, #167, #169, #170) brought one
   more POSIX-only daemon file and three more socket test files.
   `capture.cpp` now spells `fsync` and `ftruncate` as the CRT's
   `_commit` and `_chsize_s` on Windows. The socket tests in
   `click-daemon`, `punch-daemon`, and `record-daemon` skip on win32
   naming chunk 4, the same serve-mode guard as above: three
   `itOverSocket` tests in `click-daemon`, and the whole daemon describe
   in each of the other two. `click-daemon`'s `--render-live` test runs
   everywhere.

   **Amended when the keyboard instrument arrived from `main`
   (2026-10-10).** The merge of keyboard-instrument chunks 1 to 4 (#178,
   #179, #181, #182) brought `keys.cpp`, the helper behind `field keys`,
   with two things MSVC rejects. Its non-blocking stdin check used
   `poll` and `read` from `<poll.h>` and `<unistd.h>`; on Windows it asks
   `PeekNamedPipe` instead. And it publishes its source with
   `MidiOutput::createNewDevice`, which JUCE declares only on macOS and
   Linux, because Windows has no virtual MIDI ports; there the helper
   refuses with the message it gives any failed publish (§7.2 records
   the gap). `capture.cpp`'s MIDI takes reach the disk through the same
   `syncToDisk` and `truncateTo` helpers as audio takes. The native round
   trip in `keys/helper-native.test.ts` skips on win32 for want of a
   virtual port, as it skips on Linux without ALSA, and
   `record-midi-daemon`'s daemon describe takes the serve-mode guard,
   naming chunk 4.
3. **Determinism** (§1.4). Measure a Windows render against macOS and
   Linux; the toolchain floor or `clang-cl` depending on what the
   measurement says, and the UCRT — the unmeasured third libm — is where
   the surprise would come from. Gated behind chunk 2, and it is the
   chunk most likely to surprise.
4. **The transport** (§1.2). The seam, both ends, per §2.1. This is where
   `field play`, `field transport` and live rendering arrive, and it is
   the largest chunk by a wide margin.

   **Implemented (2026-08-18).** Named pipes, as §2.1 decided, and the
   decision's predictions held with one correction each way. What held:
   `FILE_FLAG_FIRST_PIPE_INSTANCE` is the flock — the stampede test
   passes with six clients racing a fresh project; Node dials the pipe
   name natively; request handling above the I/O layer is shared with
   the POSIX arm, so `dispatch` exists once. What the implementation
   taught: **CancelIoEx is an event where SHUT_RD is a state.** A cancel
   only aborts a read pending at that instant — a reader inside dispatch
   at shutdown would issue a fresh read afterward and keep serving a
   chatty client forever, so the daemon never exited. The reader now
   checks the running flag each cycle (at most one request slips
   through), and the shutdown drain is one peek deep: exactly the bytes
   buffered at the half-close, the way SHUT_RD's EOF bounds it, because
   re-peeking chases a client that keeps writing. Round trips measure
   1.3 ms. One test-infrastructure find: Windows cannot delete a
   directory that is a live process's cwd, and the daemon takes a few
   hundred milliseconds to exit after quit — `removeTempProject`
   (src/testing/temp.ts) retries the whole removal, because rmSync's
   own retry knobs do not cover every op in its recursive walk. The
   guards this chunk owed are retired: the 9 in `version.test.ts` (its
   fake daemons now bind what `socketPathFor` answers), the serve-mode
   describes, live-session's four socket tests, the recording guards
   from chunk 2's third amendment (three tests in `click-daemon`, the
   describes in `punch-daemon` and `record-daemon`), and
   `record-midi-daemon`'s describe from its fourth, whose take tests
   then skip on Windows for want of a virtual MIDI source (§7.2) —
   8/8 protocol, 12/12 play-daemon, 25+1 hosting with live chains, on
   Windows. The definition-of-done transcript, from a real session with
   a dirty chain, steered from a second terminal:

   ```text
   playing  1.4.731 (0:01.9)
   live session: proof
   device: Speakers (FxSound Audio Enhancer) @ 48000 Hz
   daemon: field-audiod 0.11.0
   ```
5. **Fallback and CI** (§1.6). The `afplay` path's Windows behaviour per
   §2.2, and a `windows-latest` job. The "V1 platform scope" amendment
   this chunk originally carried rode chunk 1 instead, because §2.4 tied
   the plan's `in-progress` flip to it.

   **Implemented (2026-08-18), riding chunk 4's diff** — the fallback
   refusal is three lines and the CI job one block, neither worth a
   review cycle alone. `playWithAfplay` on win32 fails with the build
   hint, per §2.2's no-fallback decision. The `windows-latest` job runs
   what Linux runs minus the Python gates (the workers keep their POSIX
   transport, §4). Unverified on an actual runner as of this writing:
   Actions billing on the account is broken and no job of any kind
   starts; the job is written to the Linux job's shape and waits there.

Chunks 2 and 4 are independent of each other given chunk 1, so offline
rendering on Windows can be real long before playback is.

## 6 Open questions

- **Does the detached spawn survive?** `src/audiod/client.ts:130` spawns
  the daemon with `detached: true` and `stdio: ['ignore','ignore', log]`,
  then `unref()`s it. Windows has different semantics for detachment and
  process groups, and the daemon's idle-exit and ctrl-c handling both ride
  on it. **Deferred to chunk 4, and resolved by building it**: the spawn
  path first runs on Windows when the transport exists to connect to, and
  the daemon protocol tests plus a real `field play` session are exactly
  the verification — a separate investigation would only rehearse what
  the chunk proves.

  **Answered (2026-08-18, chunk 4): it survives.** The protocol
  suite spawns detached daemons all day, idle-exit fires, ctrl-c during
  a real `field play` returns the terminal, and the daemon outlives its
  spawning CLI exactly as designed.
- **Is the 104-byte reasoning simply gone, or replaced?** **Answered by
  §2.1 and §2.3 (2026-08-16)**: named pipes won, so `socketPathFor`'s
  104-byte premise is macOS/Linux-only. On Windows the same function
  returns a pipe name derived from the project root, and its comment says
  which question each platform's branch answers. Chunk 4 wrote that
  branch, in `src/socketPath.ts`.
- **What does WASAPI do to the device story?** `field devices` and
  `--device` are built on JUCE's `AudioDeviceManager`, which on Windows
  offers WASAPI (shared and exclusive) and DirectSound, plus ASIO only
  with a non-redistributable SDK. Whether device *names* round-trip
  through `device.select` the way they do on Core Audio is unverified,
  and the periodic rescan fallback has never been exercised against real
  Windows hot-plug. **Deferred to chunk 4**: both are observable only
  against a live daemon, which does not exist before the transport does —
  `field devices` against WASAPI and one unplug during playback are the
  test, and chunk 4's definition of done should name them.

  **Mostly answered (2026-08-18, chunk 4)**: real
  device names enumerate and round-trip on real hardware (`field
  devices` lists the machine's WASAPI outputs with the default starred;
  a live session reports its device by name), and null mode serves CI.
  Still unexercised: a physical unplug during playback — one manual
  test whenever a session is playing and a cable is handy.
- **Does anything else hash on-disk bytes?** §1.1 names four
  consumers — three found by reading, the state-blob refusal by
  minjudd's grep on #154, which also placed `commands/click.ts` and
  `graph/build.ts`'s hashers inside the asset-pin family already
  listed. **Answered (2026-08-17**, the systematic grep, run in #157's
  review): every non-test hasher in `src/` reaches file bytes through
  `src/hash.ts`, and every caller maps onto a family §1.1 already names —
  the `sc-render` action key, the asset-pin family (`export`,
  `generate`, `import`, `land`, `graph/build`, `model/project`), the
  state-blob refusal, with `graph/build.ts`'s `actionKey` fed by those
  input hashes. Re-checked 2026-10-10: `click` no longer hashes anything,
  `land` hashes each landed `.wav` take for its ledger row, and
  `remote/client.ts` hashes download bytes off the network, not off
  disk. The one byte-consumer that is **not** a hash and that a grep
  for `createHash` would miss: `field check`'s canonical-formatting gate
  compares `canonicalText(file.raw, file.order) !== file.raw` against a
  raw `readFileSync` (the formatting check in `model/project.ts`), so a
  CRLF tree fails it by string comparison rather than by digest — §1.1's
  second consumer, named here so nobody re-derives it.

## 7 Master inventory — everything else that has to port

Swept 2026-08-17 on `main` at `4f90a87` plus chunk 2's working branch:
every spawn site, path literal, and platform tool in `src/`, the daemon,
the Python workers, and the test surface — the discoveries of chunks 1–2
folded in beside what only reading found. Each item names where it
lands. The chunk numbers are §5's; "workers" is the future chunk §4
defers to; **standalone** marks work small and independent enough to
land as its own diff whenever.

### 7.1 In the committed chunks already

- **The transport, both ends** (§1.2, §2.1 — chunk 4): the named-pipe
  `Server` (accept loop over HANDLEs, drain via `CancelIoEx` replacing
  `shutdown(SHUT_RD)`, single-owner via `FILE_FLAG_FIRST_PIPE_INSTANCE`
  replacing `flock`), `socketPathFor`'s pipe-name branch (§2.3), and
  `audiod/client.ts` connecting to `\\.\pipe\…`. Removes the chunk-2
  serve-mode stub in `server.cpp` and every guard whose comment names
  chunk 4: the 9 in `version.test.ts`, and the serve-mode guards §5's
  chunk 2 amendments list — the describes in `audiod/client`,
  `play-daemon`, plugin-hosting's live chains, `punch-daemon`,
  `record-daemon`, and `record-midi-daemon`, the 4 `itOverSocket` tests
  in `live-session`, and the 3 in `click-daemon`. The other
  guards chunk 2 planted are not chunk 4's to remove: the 21 in
  `generate.test.ts` and 3 describes in `aced`/`voiced` are the workers
  chunk's (§7.3 carries them), and `build.test.ts`'s 2 sclang stubs are
  nobody's — only a second stub dialect would unskip those (#158
  review). A caveat on all these counts: chunk 2 is swept here from the
  local `windows/build`, unlanded as of this section, so the numbers
  can move until it lands.
- **Detached spawn + WASAPI verification** (§6 → chunk 4's definition of
  done): idle-exit and ctrl-c through Windows process groups; device
  names round-tripping `device.select`; one real unplug against the
  heartbeat rescan.
- **Float determinism** (§1.4 — chunk 3): the VS 2022 toolchain floor
  (whose default `/fp:precise` generates no contractions — the floor is
  the guard, not any flag) or `clang-cl`, measured by the
  cross-platform byte comparison, with the UCRT libm the likeliest
  surprise.
- **`afplay`** (§1.6, §2.2 — chunk 5): dies on Windows by decision; the
  code change is making the refusal say "build the daemon".
- **CI** (chunk 5): a `windows-latest` job — pnpm through
  `pnpm/action-setup@v4` as the Linux job installs it, the VS
  generator, the JUCE FetchContent cache keyed per-OS, and the same
  suite the Linux job runs.

### 7.2 Found by the sweep, not yet in any chunk

- **`field init` planted chunk 1's defect in every new project**
  (`commands/init.ts:60` at `4f90a87`): the `.gitattributes` it wrote
  carried only the seven LFS filter lines — no `* text=auto eol=lf`, no
  `*.state` override — so a project created on (or cloned to) Windows
  had the §1.1 checkout corruption against its *own* committed `.scd`
  programs and asset pins, engine fix notwithstanding. **Done in #159**
  (merged 2026-10-10): `init` now writes `* text=auto eol=lf` ahead of
  the LFS lines and `*.state binary` after them, chunk 1's file as the
  template. It stays in this list as the record of the sweep that
  found it.
- **The picker runs raw-mode VT decoding** (`commands/picker.ts:93`,
  `field insert add`'s chooser, #155): arrows are parsed as CSI
  sequences from a `setRawMode(true)` stdin. Windows Terminal and
  ConPTY deliver VT input on modern Windows, but nobody has run this
  picker there — arrows, escape, ctrl-c mid-raw-mode, and the terminal
  restoring on exit all need one manual pass. **Standalone** (verify,
  then fix only what fails).
- **`homeRelative` never fires on Windows** (`commands/export.ts:69`):
  `startsWith(`${home}/`)` hardcodes the separator, so no exported path
  ever prints with a tilde — cosmetic, wrong quietly. Its sibling
  `defaultExportDir()` is `join(homedir(), 'Desktop')`, which on a
  OneDrive-redirected profile is not the Desktop the user sees (the
  real one lives under `OneDrive\Desktop`); the export still lands and
  prints its path, so this is a wart rather than a break. **Standalone.**
- **`sclangCommand` cannot find `sclang` on Windows**
  (`sclangCommand` in `generators/supercollider.ts`, re-checked
  2026-10-10 after #179). Since the keyboard instrument's voice host
  (#179), the lookup finds `sclang` itself rather than leaving the
  search to `execFile`, and SuperCollider renders and the `field keys`
  voice host both go through it. Three parts of it are POSIX-shaped:
  its PATH search tries only `sclang`, never `sclang.exe`; a
  `FIELD_SCLANG` with no `/`, such as
  `C:\Program Files\SuperCollider-3.13.0\sclang.exe`, goes through that
  same PATH search and is reported missing; and the fallback probes
  `/Applications/SuperCollider.app/…`, whose Windows spelling is
  `C:\Program Files\SuperCollider-<v>\sclang.exe`. Porting it means
  trying `.exe` on PATH and accepting a native absolute `FIELD_SCLANG`,
  as well as the fallback. **Standalone**, and §4 already scopes
  SuperCollider itself to "whenever it is wanted".

  **Ported (2026-10-11).** On Windows the PATH search tries each
  PATHEXT extension and never a bare name, a `FIELD_SCLANG` holding a
  backslash, slash, or drive is read as a path, the fallback takes the
  newest `SuperCollider-<version>` under Program Files, and `PATH`,
  `PATHEXT`, and `ProgramFiles` are read without regard to case, as a
  copied environment spells them. `generators/supercollider.test.ts`
  covers each rule with the platform passed in, so it runs everywhere.
- **`git lfs install --local` failure advice** (`commands/init.ts:71`):
  the catch prints a warning and moves on, which is right; unverified
  whether the probe succeeds under a Windows CI shell where `git`
  resolves but the LFS subcommand may not. One CI run answers it, with
  the `windows-latest` job (chunk 5).
- **Crash recovery on Windows** (`record-daemon.test.ts`, "a daemon
  killed mid-take leaves a recoverable transaction"): on the
  `windows-latest` runner a request to the freshly spawned daemon fails
  with "field-audiod connection closed", so the daemon drops the
  connection or dies while it lists or recovers the killed take. The
  cause is not diagnosed. `Transaction::recover`'s errors are thrown and
  answered as error responses, so a crash would have to bypass
  exceptions; the CRT's invalid-parameter handler in `truncateAndSync`
  is one candidate. The test's temp project, and its `audiod.log`, is
  removed with it. The test skips on win32 until this is found.
  **Standalone**: start from the daemon log of one Windows run.
- **`field keys` cannot publish a source on Windows**
  (`native/audiod/src/keys.cpp`): the helper publishes the computer
  keyboard as a virtual MIDI source, and Windows has no virtual MIDI
  ports, so JUCE offers no `createNewDevice` there and the helper
  refuses (chunk 2's amendment). Recording from a hardware controller
  is unaffected. Playing keys on Windows needs a different route: a
  loopback driver such as loopMIDI, Windows MIDI Services, or feeding
  the voice host without a MIDI port at all. **Standalone**, and a
  design question before it is a port.

### 7.3 The workers chunk, when it opens (§4 stands)

- `python/worker/src/field_worker/server.py:129` binds
  `socket.AF_UNIX`; CPython has no named-pipe socket family, so the
  Python end is a **transport decision of its own** — loopback TCP is
  the likely answer where the daemon chose pipes, and it is not this
  plan's §2.1 verbatim. The same file fails earlier than that: line 23
  imports `fcntl` for the single-owner `flock`, and Windows CPython has
  no `fcntl` module, so the import raises before line 129 runs. The
  single-owner guarantee needs its own Windows answer alongside the
  transport. (Citations here are against `main` at
  `4f90a87`; chunk 2's branch shifts `client.ts` by ten lines.)
- `workers/client.ts:122,305` advises `brew install uv` — needs the
  winget/scoop spelling behind a platform switch. Line 345 is the same
  kind of advice: it prints `pkill -f` as the remedy for a protocol
  mismatch, and Windows has no `pkill`.
- The chunk-2 test guards that wait here, not on chunk 4: the 21
  stub-spawning tests in `generate.test.ts` and the three `describe`s
  in `aced/client.test.ts` and `voiced/client.test.ts`, all guarded on
  the workers' POSIX transport with §4 named in the comment.
- `workerScriptInstalled` probes `Scripts/` but joins `spec.script`
  bare; uv's Windows console shims carry `.exe` (§4 note, unverified).
- The model environments themselves: `uv.lock` already resolves win32
  CUDA wheels, `triton-windows`, and a Windows `flash-attn`, so the
  heavy half has been priced by someone already.

### 7.4 Consumers this unblocks, not port work itself

- **The UI plan (#156)** speaks transport and levels over the files —
  its Windows story is chunk 4's transport plus the paths above, and it
  inherits both by construction if it lands after them.
- **`field open`** (add-insert chunk 3, unlanded) will need `start`
  where macOS says `open` the day it exists — noted so its review asks.
- **Display-only `relative()` calls** (`transport.ts:120`,
  `version.ts:286`) print native separators by design and port as-is.
  Chunk 2 (#160) sets the rule they sit outside: a project-relative
  path is slash-separated wherever it is *data* — stored, compared, or
  sent over the wire — and a path only printed for a person keeps the
  platform's separator. They are named here so nobody "fixes" them
  into slashes.
- **`transport.ts:58` is data, not display — the data half of that
  rule, already on the right side of it** (#158 review, correcting this
  section's first pass, which filed it under display). `songDirOfPath`
  splits its `relative()` result on the native `sep` and returns
  `songs/<name>` slash-joined, and `transport.ts:44` compares that
  against `song.dir` — the very field chunk 2 normalizes. Before that
  fix the two disagreed on Windows and `field transport` could not
  resolve a song from a path at all. It ports as-is *because* the
  split below it is native; converting the `relative()` result to
  forward slashes would break it.
